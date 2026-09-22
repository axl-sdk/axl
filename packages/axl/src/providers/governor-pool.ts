/**
 * Per-runtime pool of rate governors, one per **scope**.
 *
 * A provider's rate limits belong to the account and model, not to an adapter
 * instance. Before this pool, every built-in adapter built its own
 * `RateLimiter`, so `openai:` and `openai-responses:` on one key got two
 * independent caps (effective concurrency = the sum), and one cap covered every
 * model the adapter served. Here a scope is
 *
 *   provider family + base-URL origin + credential source + model
 *
 * - **Family**: `openai` for both OpenAI adapters (Chat Completions and
 *   Responses share an account's limits); otherwise the adapter or preset name.
 * - **Origin**: `new URL(baseUrl).origin`, so a proxy or a self-hosted endpoint
 *   is a different account. The origin carries no userinfo, path or query.
 * - **Credential source**: a callback `apiKey` by *identity* (a rotating token
 *   callback is one scope), a string by *value* (two tenants' keys never
 *   share). Each source maps to an opaque in-process number; the key itself is
 *   never part of a map key that is logged, never in a warning, never in an
 *   error.
 * - **Model**: the effective wire model of the call. There is no model-family
 *   table; models that share a vendor bucket are separate scopes.
 *
 * Ownership: the runtime's `ProviderRegistry` holds one pool and hands it to the
 * built-in factories, which join the adapter they construct to it at
 * construction ({@link bindGovernorPool}). An adapter constructed directly
 * joins a private pool on its first call, so one instance registered in two runtimes shares its
 * governors (the documented explicit cross-runtime sharing path). Sharing is
 * never inferred from equal keys across runtimes.
 *
 * Config merge: only when two provider blocks reach one account (for example
 * `providers.openai` and `providers['openai-responses']` with the same key and
 * origin). Each explicit field takes the strictest value and the conflict is
 * warned about once per account. Merging only ever tightens, so a live
 * governor can adopt the merged limits in place.
 *
 * Internal: nothing here is barrel-exported.
 */
import { RateLimiter, sanitizeRateLimitConfig, type RateLimitConfig } from './rate-limiter.js';
import { quotaDialectFor, type QuotaDialect } from './quota.js';
import type { ApiKeySource } from './types.js';

/** Default for `RateLimitConfig.maxRateLimitRetries` (plan §4.1, Q8). */
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 8;

/**
 * The governor for one scope. A {@link RateLimiter} whose limits can be
 * tightened in place when a second provider block reaches the same account.
 *
 * On a scope with a quota dialect and `adaptive` not `false`
 * ({@link ScopeGovernor.adapts}), it is also the scope's **fleet brake**:
 * `fetchWithRetry` calls {@link brake} after classifying a rate-limit 429, and
 * from then until `brakeUntil` no call on the scope is granted a permit or
 * dispatches. `braked()`, `awaitClear()` and `pump()` share one predicate,
 * `Date.now() < brakeUntil`. A scope that does not adapt never brakes, so it
 * behaves exactly as a plain `RateLimiter`.
 */
export class ScopeGovernor extends RateLimiter {
  // `RateLimiter`'s constructor runs the overridden `pump()` before these
  // fields are initialized, so every brake read must treat `undefined` as
  // "not braked" (see `braked()`).
  private brakeUntil?: number;
  private brakeEndTimer?: ReturnType<typeof setTimeout>;
  private brakeEndAt?: number;
  private adaptive = true;
  private rateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES;
  private warnedHint = false;
  /**
   * The last 2xx quota hint (`remaining / limit`, see `quota.ts`), for the
   * adaptive-rate phase to hold recovery on. Not read yet.
   */
  lastHint: number | undefined;
  /**
   * `dispatchedAt` of the most recent request that drew a rate-limit 429.
   * The adaptive-rate phase cuts at most once per congestion epoch by
   * comparing it with the time of the last cut. Not read yet.
   */
  lastRateLimitedDispatchAt: number | undefined;

  /**
   * @param limits already sanitized (see `sanitizeRateLimitConfig`).
   * @param dialect the scope's quota dialect; `undefined` for a dialect-less scope.
   * @param family the provider family, only to name the scope in a warning.
   */
  constructor(
    limits: RateLimitConfig,
    readonly dialect?: QuotaDialect,
    private readonly family = 'provider',
  ) {
    super();
    this.reconfigure(limits);
  }

  /** Adopt the account's merged limits. Merges only tighten (see {@link STRICTEST}). */
  reconfigure(limits: RateLimitConfig): void {
    this.adaptive = limits.adaptive ?? true;
    this.rateLimitRetries = limits.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.applyLimits(limits);
  }

  /** Whether this scope brakes and retries rate-limit 429s on their own budget. */
  get adapts(): boolean {
    return this.dialect !== undefined && this.adaptive;
  }

  /** The rate-limit retry budget (`maxRateLimitRetries`). */
  get maxRateLimitRetries(): number {
    return this.rateLimitRetries;
  }

  /** The brake predicate shared by `awaitClear`, `pump` and `fetchWithRetry`. */
  braked(): boolean {
    return this.brakeUntil !== undefined && Date.now() < this.brakeUntil;
  }

  /**
   * Brake every call on the scope for `ms` (already clamped by the caller to
   * the transport's backoff ceiling). Extends, never shortens, an active
   * brake. `dispatchedAt` is when the 429'd request left.
   *
   * This is the seam the adaptive-rate cut attaches to.
   */
  brake(ms: number, dispatchedAt: number): void {
    this.lastRateLimitedDispatchAt = dispatchedAt;
    const until = Date.now() + Math.max(0, ms);
    if (this.brakeUntil === undefined || until > this.brakeUntil) this.brakeUntil = until;
    this.pump();
  }

  /**
   * Resolve once the scope is not braked. Rejects with `signal.reason` if the
   * signal is already aborted (even when not braked) or aborts while waiting.
   */
  async awaitClear(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    while (this.braked()) await this.sleepUntilBrakeEnd(signal);
  }

  /**
   * Re-acquire a permit for a call that already dispatched (after a
   * rate-limit 429, or a transient backoff that woke into a brake): queued
   * ahead of first-time callers and exempt from `acquireTimeoutMs`.
   */
  reacquire(signal?: AbortSignal): Promise<void> {
    return this.enqueue(signal, { priority: true, timeoutMs: undefined });
  }

  /** Read the quota hint on a 2xx. Total: a throwing dialect warns once and is ignored. */
  override observe(res: Response): void {
    if (!this.adapts || !res.ok) return;
    try {
      this.lastHint = this.dialect!.hint(res.headers);
    } catch {
      this.lastHint = undefined;
      if (!this.warnedHint) {
        this.warnedHint = true;
        // Never includes header values.
        console.warn(
          `[axl] Rate governor: could not read ${this.family} quota headers; ignoring them for this scope.`,
        );
      }
    }
  }

  /** Grants nothing while braked; re-pumps at the brake's end if anyone is queued. */
  protected override pump(): void {
    if (this.braked()) {
      if (this.hasWaiters()) this.armBrakeEnd();
      return;
    }
    super.pump();
  }

  private armBrakeEnd(): void {
    const until = this.brakeUntil!;
    if (this.brakeEndTimer !== undefined && this.brakeEndAt === until) return;
    if (this.brakeEndTimer !== undefined) clearTimeout(this.brakeEndTimer);
    this.brakeEndAt = until;
    this.brakeEndTimer = setTimeout(() => {
      this.brakeEndTimer = undefined;
      this.brakeEndAt = undefined;
      this.pump();
    }, until - Date.now());
  }

  private sleepUntilBrakeEnd(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, this.brakeUntil! - Date.now());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Per-field "stricter of two explicit values". Keyed by every field of
 * `RateLimitConfig`, so a new config field does not compile until it states
 * how two provider blocks combine.
 */
const STRICTEST: {
  [K in keyof Required<RateLimitConfig>]: (
    a: NonNullable<RateLimitConfig[K]>,
    b: NonNullable<RateLimitConfig[K]>,
  ) => NonNullable<RateLimitConfig[K]>;
} = {
  maxConcurrent: (a, b) => Math.min(a, b),
  minIntervalMs: (a, b) => Math.max(a, b),
  acquireTimeoutMs: (a, b) => Math.min(a, b),
  // Adapting only ever slows a scope down, and it is what prevents item loss
  // under a rate limit, so an explicit `true` beats an explicit `false`.
  adaptive: (a, b) => a || b,
  maxRateLimitRetries: (a, b) => Math.min(a, b),
};

type MergeResult = {
  merged: RateLimitConfig;
  /** One `field: a vs b` entry per field both sides set to different values. */
  conflicts: string[];
};

/** Merge two sanitized configs, taking the strictest explicit value per field. */
function mergeStrictest(a: RateLimitConfig, b: RateLimitConfig): MergeResult {
  const merged: RateLimitConfig = { ...a };
  const conflicts: string[] = [];
  const mergeField = <K extends keyof RateLimitConfig>(field: K): void => {
    const av = a[field];
    const bv = b[field];
    if (bv === undefined) return;
    if (av === undefined) {
      merged[field] = bv;
      return;
    }
    if (av !== bv) conflicts.push(`${field}: ${av} vs ${bv}`);
    merged[field] = STRICTEST[field](
      av as NonNullable<RateLimitConfig[K]>,
      bv as NonNullable<RateLimitConfig[K]>,
    );
  };
  for (const field of Object.keys(STRICTEST) as (keyof RateLimitConfig)[]) mergeField(field);
  return { merged, conflicts };
}

function formatLimits(limits: RateLimitConfig): string {
  const parts = (Object.keys(STRICTEST) as (keyof RateLimitConfig)[])
    .filter((field) => limits[field] !== undefined)
    .map((field) => `${field}=${limits[field]}`);
  return parts.join(', ');
}

/** What an adapter declares about itself to find its scope. */
export type GovernorScopeIdentity = {
  /** Provider family (`openai` for both OpenAI adapters). */
  family: string;
  /** The adapter's normalized base URL; only its origin is used. */
  baseUrl: string;
  /** The adapter's credential source. Compared, never stored in a key or logged. */
  apiKeySource: ApiKeySource;
  /** The adapter's `Provider.name`, used only to name it in the merge warning. */
  adapterName: string;
};

/**
 * Everything a scope shares except the model: one provider account as seen
 * from this runtime. Holds the merged config and one governor per model.
 */
export class AccountScope {
  /** `undefined` until some provider block reaching this account sets `rateLimit`. */
  private limits: RateLimitConfig | undefined;
  private readonly adapterNames: string[] = [];
  private warnedConflict = false;
  private readonly governors = new Map<string, ScopeGovernor>();
  private readonly dialect: QuotaDialect | undefined;

  constructor(
    private readonly family: string,
    private readonly origin: string,
  ) {
    this.dialect = quotaDialectFor(family);
  }

  /** Record one provider block's (sanitized) `rateLimit`, merging strictest. */
  contribute(adapterName: string, limits: RateLimitConfig | undefined): void {
    const previousNames = [...this.adapterNames];
    this.adapterNames.push(adapterName);
    if (limits === undefined) return;
    if (this.limits === undefined) {
      this.limits = { ...limits };
      // A dialect scope has governors before any block sets `rateLimit`.
      for (const governor of this.governors.values()) governor.reconfigure(this.limits);
      return;
    }
    const { merged, conflicts } = mergeStrictest(this.limits, limits);
    this.limits = merged;
    for (const governor of this.governors.values()) governor.reconfigure(merged);
    if (conflicts.length > 0 && !this.warnedConflict) {
      this.warnedConflict = true;
      // Names the adapters, family and origin only — never the credential or
      // anything derived from it.
      console.warn(
        `[axl] Rate limit: providers ${[...new Set([...previousNames, adapterName])]
          .map((n) => `"${n}"`)
          .join(
            ' and ',
          )} reach one rate-limit scope (${this.family} at ${this.origin}, same credential) ` +
          `with different rateLimit values (${conflicts.join('; ')}). ` +
          `They share one governor per model using the strictest values: ${formatLimits(merged)}.`,
      );
    }
  }

  /**
   * The governor for `model`, created on first use and memoized.
   *
   * A scope with a quota dialect (first-party OpenAI, Anthropic) always has
   * one, so its fleet brake works with no configuration; with no `rateLimit`
   * it applies no cap and no spacing, so nothing waits before the first
   * rate-limit 429. A dialect-less scope returns `undefined` while no block
   * reaching this account configured `rateLimit`, so it takes
   * `fetchWithRetry`'s no-governor path, byte-identical to before pooling.
   * Re-evaluated on every call: a block contributing `rateLimit` later governs
   * every adapter on the account from its next call on.
   */
  governorFor(model: string): ScopeGovernor | undefined {
    if (this.limits === undefined && this.dialect === undefined) return undefined;
    let governor = this.governors.get(model);
    if (!governor) {
      governor = new ScopeGovernor(this.limits ?? {}, this.dialect, this.family);
      this.governors.set(model, governor);
    }
    return governor;
  }
}

/** The per-runtime pool. Owned by a `ProviderRegistry`, or private to one adapter. */
export class GovernorPool {
  private readonly accounts = new Map<string, AccountScope>();
  private readonly stringCredentialIds = new Map<string, number>();
  private readonly callbackCredentialIds = new WeakMap<object, number>();
  private nextCredentialId = 1;

  /**
   * Join the account `identity` describes, contributing the adapter's
   * sanitized `rateLimit` (or `undefined` for none).
   */
  attach(identity: GovernorScopeIdentity, limits: RateLimitConfig | undefined): AccountScope {
    const origin = new URL(identity.baseUrl).origin;
    const key = JSON.stringify([identity.family, origin, this.credentialId(identity.apiKeySource)]);
    let account = this.accounts.get(key);
    if (!account) {
      account = new AccountScope(identity.family, origin);
      this.accounts.set(key, account);
    }
    account.contribute(identity.adapterName, limits);
    return account;
  }

  /** Opaque in-process id: callbacks by identity, strings by value. */
  private credentialId(source: ApiKeySource): number {
    if (typeof source === 'function') {
      let id = this.callbackCredentialIds.get(source);
      if (id === undefined) {
        id = this.nextCredentialId++;
        this.callbackCredentialIds.set(source, id);
      }
      return id;
    }
    let id = this.stringCredentialIds.get(source);
    if (id === undefined) {
      id = this.nextCredentialId++;
      this.stringCredentialIds.set(source, id);
    }
    return id;
  }
}

const adapterGovernors = new WeakMap<object, AdapterGovernors>();

/**
 * Join a registry's pool on behalf of an adapter a built-in factory just
 * constructed. Joining at construction (not at the first call) means a block's
 * `rateLimit` governs its scope from the moment the adapter is resolved, even
 * if another adapter on the same scope calls first. Returns the adapter.
 */
export function bindGovernorPool<P extends object>(adapter: P, pool: GovernorPool): P {
  const governors = adapterGovernors.get(adapter);
  if (!governors) {
    throw new Error('[axl] internal: this provider does not resolve pooled rate governors');
  }
  governors.join(pool);
  return adapter;
}

/**
 * An adapter's handle on its governors, constructed in the adapter's
 * constructor. `rateLimit` is validated there (warning at construction, as a
 * per-adapter `RateLimiter` always did). A built-in factory then joins the
 * registry's pool ({@link bindGovernorPool}); an adapter constructed directly
 * joins a private pool on its first call.
 */
export class AdapterGovernors {
  private readonly limits: RateLimitConfig | undefined;
  private account?: AccountScope;

  constructor(
    adapter: object,
    private readonly identity: GovernorScopeIdentity,
    rateLimit: RateLimitConfig | undefined,
  ) {
    this.limits = rateLimit ? sanitizeRateLimitConfig(rateLimit) : undefined;
    adapterGovernors.set(adapter, this);
  }

  /** Join `pool`'s scope for this adapter. Once only: a second join is a wiring bug. */
  join(pool: GovernorPool): AccountScope {
    if (this.account) {
      throw new Error('[axl] internal: this provider has already joined a governor pool');
    }
    this.account = pool.attach(this.identity, this.limits);
    return this.account;
  }

  /** The governor for a call to `model`, or `undefined` when the scope is ungoverned. */
  governorFor(model: string): ScopeGovernor | undefined {
    const account = this.account ?? this.join(new GovernorPool());
    return account.governorFor(model);
  }
}
