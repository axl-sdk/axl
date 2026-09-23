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
 * Tuning of the adaptive rate (rate-space AIMD) on a dialect scope. Internal
 * and never config: the only contract is "slower is always safe". Exported so
 * tests derive their expectations from these values instead of restating them.
 */
export const ADAPTIVE_RATE = Object.freeze({
  /** The sliding window of grants (and braked spans) that demand is measured over. */
  WINDOW_MS: 10_000,
  /** Multiplicative decrease: a cut sets `rate = BETA × min(rate, demand)`. */
  BETA: 0.5,
  /**
   * Additive increase: `alpha = max(rateAtLastCut, ALPHA_FLOOR_RATE) / R` per
   * second of success, so one cut's rate comes back in this much successful time.
   */
  RECOVERY_HORIZON_MS: 30_000,
  /**
   * The rate `alpha` is proportional to when the last cut left the scope slower
   * than this (grants per second). Without it, a stray 429 on a quiet scope
   * seeds a tiny rate that also climbs tinily, pinning a later fan-out for
   * many minutes (review F1).
   */
  ALPHA_FLOOR_RATE: 5,
  /** The floor a cut never goes below, in grants per second. */
  MIN_RATE: 0.25,
  /** Demand is trusted only once the window holds this much unbraked time (after a brake). */
  MIN_DEMAND_SPAN_MS: 1_000,
  /** A 2xx whose quota hint (`remaining / limit`) is below this holds growth and reopening. */
  HINT_THRESHOLD: 0.1,
  /** Reopen once `rate` exceeds the window's peak one-second grant count by this factor… */
  REOPEN_FACTOR: 4,
  /** …continuously for this long, with no 429 and a healthy hint. */
  REOPEN_PERIOD_MS: 10_000,
});

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
  // `RateLimiter`'s constructor runs the overridden `pump()` and
  // `grantIntervalMs()` before these fields are initialized, so every brake and
  // rate read must treat `undefined` as "not braked" / "fully open".
  private brakeUntil?: number;
  private brakeEndTimer?: ReturnType<typeof setTimeout>;
  private brakeEndAt?: number;
  private adaptive = true;
  private rateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES;
  private warnedHint = false;
  private warnedEngaged = false;
  /** The last 2xx quota hint (`remaining / limit`, see `quota.ts`); a low one holds growth. */
  lastHint: number | undefined;

  // --- Adaptive rate (plan §4.4). Only an adapting scope records or reads these.
  /**
   * Grants per second, or `undefined` while the scope is fully open (its state
   * until the first rate-limit 429, and again after it reopens). Enforced as a
   * minimum gap of `1000 / rate` ms between grants, never below `minIntervalMs`.
   */
  private rate: number | undefined;
  /** The rate the last cut set; recovery adds `max(rateAtLastCut, ALPHA_FLOOR_RATE) / R` per second. */
  private rateAtLastCut = 0;
  /** When the last cut happened. A 429 cuts only if its request left after this. */
  private lastCutAt = Number.NEGATIVE_INFINITY;
  /**
   * Recovery accrues from here. Advanced by each 2xx and pushed to the end of
   * any brake, so braked time never accrues.
   */
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  /** Since when the reopen condition has held on every 2xx; `undefined` while it doesn't. */
  private reopenSince: number | undefined;
  /** Grant timestamps within `WINDOW_MS`, oldest first, from `grantsHead` on. */
  private grants: number[] = [];
  private grantsHead = 0;
  /** Braked spans overlapping the window, oldest first, non-overlapping. */
  private brakeSpans: { start: number; end: number }[] = [];

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
   * On a rate-limit 429: brake every call on the scope for `ms` (already
   * clamped by the caller to the transport's backoff ceiling), and cut the
   * adaptive rate. Extends, never shortens, an active brake. `dispatchedAt` is
   * when the 429'd request left.
   *
   * The cut happens at most once per congestion epoch: only when the 429'd
   * request left after the last cut. The rest of a wave that was already in
   * flight extends the brake without cutting again.
   */
  brake(ms: number, dispatchedAt: number): void {
    const now = Date.now();
    if (dispatchedAt > this.lastCutAt) this.cut(now);
    const until = now + Math.max(0, ms);
    if (this.brakeUntil === undefined || until > this.brakeUntil) this.brakeUntil = until;
    this.recordBrakeSpan(now, this.brakeUntil);
    this.lastProgressAt = Math.max(this.lastProgressAt, this.brakeUntil);
    this.reopenSince = undefined;
    this.pump();
  }

  /** The adaptive rate in grants per second; `undefined` while fully open. @internal */
  get currentRate(): number | undefined {
    return this.rate;
  }

  /**
   * `rate = BETA × min(rate ?? ∞, demand)`, floored at `MIN_RATE`, where demand
   * is grants in the window over its unbraked elapsed time (floored at 1 s).
   * Demand is used only when it can be trusted: when no brake overlaps the
   * window (a burst from a cold scope reads its true count), or once the window
   * holds `MIN_DEMAND_SPAN_MS` of unbraked time. Right after a long brake the
   * window holds only a few spaced grants, so the cut uses the current rate.
   */
  private cut(now: number): void {
    const { WINDOW_MS, BETA, MIN_RATE, MIN_DEMAND_SPAN_MS } = ADAPTIVE_RATE;
    const windowStart = now - WINDOW_MS;
    this.pruneWindow(now);
    const count = Math.max(1, this.grants.length - this.grantsHead);
    const spanStart = Math.max(windowStart, this.grants[this.grantsHead] ?? now);
    const unbraked = now - spanStart - this.brakedOverlap(spanStart, now);
    const demand = (count * 1000) / Math.max(unbraked, 1000);
    const trusted =
      this.rate === undefined ||
      unbraked >= MIN_DEMAND_SPAN_MS ||
      this.brakedOverlap(windowStart, now) === 0;
    const base = trusted ? Math.min(this.rate ?? Infinity, demand) : this.rate!;
    this.rate = Math.max(MIN_RATE, BETA * base);
    this.rateAtLastCut = this.rate;
    this.lastCutAt = now;
    if (!this.warnedEngaged) {
      this.warnedEngaged = true;
      // Names the family only — never the credential, origin or model.
      console.warn(
        `[axl] Rate governor: ${this.family} returned a rate-limit 429; pacing this scope ` +
          `(one model on one account) adaptively until it stops being throttled. ` +
          `Set rateLimit: { adaptive: false } to turn this off.`,
      );
    }
  }

  /** Advance recovery on a 2xx, then check whether the scope can reopen (plan §4.4, Q11). */
  private recover(now: number): void {
    if (this.rate === undefined) return;
    const { RECOVERY_HORIZON_MS, ALPHA_FLOOR_RATE, HINT_THRESHOLD, REOPEN_PERIOD_MS } =
      ADAPTIVE_RATE;
    // Success-gated time (Q11): per 2xx, at most max(1 s, the current spacing
    // interval). A gap Axl's own spacing imposed is not idle time; idle time
    // beyond it never accrues, and braked time never does (`lastProgressAt` is
    // pushed to the brake's end).
    const capMs = Math.max(1000, 1000 / this.rate);
    const accruedMs = Math.min(Math.max(0, now - this.lastProgressAt), capMs);
    this.lastProgressAt = Math.max(this.lastProgressAt, now);
    const hintLow = this.lastHint !== undefined && this.lastHint < HINT_THRESHOLD;
    // A low hint only holds growth; it never admits more.
    if (hintLow) {
      this.reopenSince = undefined;
      return;
    }
    const alphaBase = Math.max(this.rateAtLastCut, ALPHA_FLOOR_RATE);
    this.rate += (alphaBase * accruedMs) / RECOVERY_HORIZON_MS;
    if (this.farAbovePeakDemand(now)) {
      this.reopenSince ??= now;
      if (now - this.reopenSince >= REOPEN_PERIOD_MS) {
        this.rate = undefined;
        this.reopenSince = undefined;
      }
    } else {
      this.reopenSince = undefined;
    }
  }

  /**
   * Whether `rate` exceeds `REOPEN_FACTOR ×` the window's peak one-second grant
   * count. The peak is at least the window's per-second average, so a scope
   * paced near its demand (the common case, with the largest window) is
   * answered without the O(window) scan.
   */
  private farAbovePeakDemand(now: number): boolean {
    const { REOPEN_FACTOR, WINDOW_MS } = ADAPTIVE_RATE;
    this.pruneWindow(now);
    const inWindow = this.grants.length - this.grantsHead;
    if (this.rate! <= (REOPEN_FACTOR * inWindow * 1000) / WINDOW_MS) return false;
    return this.rate! > REOPEN_FACTOR * this.peakOneSecondGrants(now);
  }

  /** The most grants in any one-second span of the window (two pointers, O(window)). */
  private peakOneSecondGrants(now: number): number {
    this.pruneWindow(now);
    let peak = 0;
    let lo = this.grantsHead;
    for (let hi = this.grantsHead; hi < this.grants.length; hi++) {
      while (this.grants[hi]! - this.grants[lo]! >= 1000) lo++;
      peak = Math.max(peak, hi - lo + 1);
    }
    return peak;
  }

  /** Total braked time inside `[from, to)`. */
  private brakedOverlap(from: number, to: number): number {
    let total = 0;
    for (const { start, end } of this.brakeSpans) {
      total += Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    return total;
  }

  private recordBrakeSpan(now: number, until: number): void {
    const last = this.brakeSpans.at(-1);
    if (last !== undefined && last.end >= now) last.end = Math.max(last.end, until);
    else this.brakeSpans.push({ start: now, end: until });
  }

  /** Drop grants and braked spans older than the window; memory stays bounded by it. */
  private pruneWindow(now: number): void {
    const windowStart = now - ADAPTIVE_RATE.WINDOW_MS;
    while (this.grantsHead < this.grants.length && this.grants[this.grantsHead]! < windowStart) {
      this.grantsHead++;
    }
    if (this.grantsHead > 64 && this.grantsHead * 2 > this.grants.length) {
      this.grants = this.grants.slice(this.grantsHead);
      this.grantsHead = 0;
    }
    while (this.brakeSpans.length > 0 && this.brakeSpans[0]!.end < windowStart) {
      this.brakeSpans.shift();
    }
  }

  protected override onGrant(at: number): void {
    if (!this.adapts) return;
    this.grants.push(at);
    this.pruneWindow(at);
  }

  /** Adaptive spacing on top of the configured `minIntervalMs`, never below it (RQ5). */
  protected override grantIntervalMs(): number {
    const configured = super.grantIntervalMs();
    return this.rate === undefined ? configured : Math.max(configured, 1000 / this.rate);
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

  /**
   * Take a permit without waiting, if `acquire()` / `reacquire()` would grant
   * one at once: not braked and a permit free. Lets the transport skip timing a
   * wait that never happened, so an unqueued call reports `queuedMs` exactly 0.
   */
  tryAcquire(): boolean {
    return !this.braked() && this.tryGrant();
  }

  /**
   * On a 2xx: read the quota hint, then advance recovery. Total: a throwing
   * dialect warns once and is ignored (the hint is then treated as healthy).
   */
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
    this.recover(Date.now());
  }

  /**
   * Grants nothing while braked; re-pumps at the brake's end if anyone is
   * queued. The brake-end timer lives only as long as its waiters: when the
   * last one leaves (abort or timeout, both of which re-pump) it is cleared, so
   * a long brake never holds the event loop open with nothing to wake. It is
   * deliberately not `unref`'d — while a waiter exists, that timer is the only
   * thing that will resume its call.
   */
  protected override pump(): void {
    if (this.braked()) {
      if (this.hasWaiters()) this.armBrakeEnd();
      else this.clearBrakeEnd();
      return;
    }
    this.clearBrakeEnd();
    super.pump();
  }

  private clearBrakeEnd(): void {
    if (this.brakeEndTimer === undefined) return;
    clearTimeout(this.brakeEndTimer);
    this.brakeEndTimer = undefined;
    this.brakeEndAt = undefined;
  }

  private armBrakeEnd(): void {
    const until = this.brakeUntil!;
    if (this.brakeEndTimer !== undefined && this.brakeEndAt === until) return;
    this.clearBrakeEnd();
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
    this.dialect = quotaDialectFor(family, origin);
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
