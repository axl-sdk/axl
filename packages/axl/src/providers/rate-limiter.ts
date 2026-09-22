/**
 * Opt-in client-side rate governor for provider HTTP calls.
 *
 * Wraps the single `fetchWithRetry` chokepoint (see `retry.ts`) so a configured
 * provider can bound how many requests it has *in flight* at once and, optionally,
 * how closely spaced its request *initiations* are. This is proactive pacing —
 * complementary to, not a replacement for, the reactive 429/503/529 backoff that
 * `fetchWithRetry` already does. The motivating case: eval fan-out
 * (`concurrency × scorerConcurrency`, up to 25 judge calls by default) on a
 * shared API key can storm a provider's rate limit; a governor smooths that.
 *
 * ## Scope & caveats (v1)
 * - **Caps request concurrency, not token throughput (TPM).** The permit is
 *   released at response *headers* on BOTH transports: `fetchWithRetry`
 *   releases in its `finally` as it returns the `Response`, and every adapter
 *   reads the body only afterwards — so `res.json()` and stream iteration alike
 *   run outside the permit. A slow stream therefore does not hold a permit for
 *   its whole lifetime. Non-streaming calls still hold it across generation in
 *   practice, because a provider sends no headers until the completion is
 *   finished. Neither bounds tokens/min.
 * - **One governor per scope, per runtime.** The built-in chat adapters don't
 *   construct this class directly: they resolve a governor per call from the
 *   runtime's `GovernorPool` (`governor-pool.ts`), one per provider family +
 *   base-URL origin + credential source + model. A directly constructed
 *   `RateLimiter` (custom adapters) governs exactly the calls it is passed to.
 *   Neither covers embedder calls (constructed outside the registry) nor other
 *   processes.
 * - **`minIntervalMs` is global spacing, not a burst bucket.** A single
 *   last-grant timestamp gates every grant: a permit may be free yet a grant
 *   still waits out the interval. There is no accumulated burst allowance.
 * - **Nesting is safe.** A permit is held only across one `fetchWithRetry` call,
 *   never across a nested `ctx.ask`, so an agent-as-tool chain on the same
 *   provider under `maxConcurrent: 1` still completes — permits don't stack.
 *
 * `observe(res)` is a no-op here. The per-scope governor in `governor-pool.ts`
 * overrides it (quota-header hint) and adds the rate-limit brake; a directly
 * constructed `RateLimiter` is never adaptive.
 */

/** Configuration for a provider's {@link RateLimiter}. All fields optional. */
export type RateLimitConfig = {
  /**
   * Maximum requests in flight at once for this provider. Must be a finite
   * integer ≥ 1; invalid values disable the concurrency cap (with a warning).
   * `1` serializes all requests (allowed, with a warning — it's a throughput
   * floor, not a deadlock: nested same-provider calls still complete because a
   * permit is never held across a nested ask).
   */
  maxConcurrent?: number;
  /**
   * Minimum milliseconds between successive request *grants* (global spacing,
   * not a per-permit rate). A permit can be free yet a grant still waits out
   * this interval. No burst bucket.
   */
  minIntervalMs?: number;
  /**
   * If set, `acquire()` rejects (fail loud) when a caller has queued longer than
   * this many ms, instead of waiting indefinitely — surfaces a misconfigured
   * cap rather than silently hanging the run.
   *
   * Bounds only a call's FIRST wait for a permit. On a scope that adapts (see
   * `adaptive`), a call first waits out any active rate-limit brake and only
   * then starts this clock; a call already queued when a brake begins keeps
   * its clock running through it. A retry's re-acquire after a rate-limit 429
   * is exempt: it is bounded by `maxRateLimitRetries` and the ask's `timeout`.
   */
  acquireTimeoutMs?: number;
  /**
   * Feedback-driven pacing on scopes with a quota dialect: first-party OpenAI
   * (`openai:` and `openai-responses:`) and Anthropic. Default `true` there;
   * it has no effect anywhere else. When on, a rate-limit 429 brakes every
   * call on the scope for its `Retry-After` (clamped at 60 s) and the call
   * retries on its own budget (`maxRateLimitRetries`); a spend-cap 429 fails
   * fast. `false` restores the plain behavior: a 429 shares the transient
   * retry budget and holds up no other call. Ignored by a directly constructed
   * `RateLimiter`, which is never adaptive.
   */
  adaptive?: boolean;
  /**
   * Retries after a rate-limit 429 on an adaptive scope, separate from the
   * transient (503/529/network) budget. Default `8`. A non-negative integer;
   * `0` still brakes the scope but returns the 429. Ignored where
   * `adaptive` has no effect.
   */
  maxRateLimitRetries?: number;
};

type Waiter = {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Set once the waiter is granted, aborted, or timed out — guards double-settle. */
  settled?: boolean;
  /** Set synchronously when the waiter is granted a permit (vs. parked in the queue). */
  granted?: boolean;
  /** Queued ahead of every non-priority waiter (a retry re-acquiring its permit). */
  priority?: boolean;
};

/**
 * Validate a {@link RateLimitConfig}, emitting the same warnings the
 * {@link RateLimiter} constructor always has, and return only the fields that
 * take effect: an invalid or non-positive value is dropped (absent), and
 * `maxConcurrent` is floored. The result is what the constructor applies, and
 * what the per-runtime governor pool merges across provider blocks, so a
 * typo'd `0` in one block never reads as the "strictest" value.
 *
 * Internal (not barrel-exported).
 */
export function sanitizeRateLimitConfig(config: RateLimitConfig): RateLimitConfig {
  const limits: RateLimitConfig = {};
  const mc = config.maxConcurrent;
  if (mc != null) {
    if (!Number.isFinite(mc) || mc < 1) {
      // A typo'd 0 / negative / NaN must not deadlock the provider — ignore the
      // cap (no limit) and say so loudly.
      console.warn(
        `[axl] RateLimiter: ignoring invalid maxConcurrent (${mc}); expected an integer >= 1. No concurrency cap applied.`,
      );
    } else {
      limits.maxConcurrent = Math.floor(mc);
      if (limits.maxConcurrent < 2) {
        console.warn(
          `[axl] RateLimiter: maxConcurrent=${limits.maxConcurrent} serializes every request to this provider. ` +
            `Nested same-provider calls still complete (permits aren't held across a nested ask), but throughput is a floor, not a guarantee.`,
        );
      }
    }
  }
  if (
    config.minIntervalMs != null &&
    Number.isFinite(config.minIntervalMs) &&
    config.minIntervalMs > 0
  ) {
    limits.minIntervalMs = config.minIntervalMs;
  }
  if (
    config.acquireTimeoutMs != null &&
    Number.isFinite(config.acquireTimeoutMs) &&
    config.acquireTimeoutMs > 0
  ) {
    limits.acquireTimeoutMs = config.acquireTimeoutMs;
  }
  if (config.adaptive != null) {
    if (typeof config.adaptive === 'boolean') {
      limits.adaptive = config.adaptive;
    } else {
      console.warn(
        `[axl] RateLimiter: ignoring invalid adaptive (${String(config.adaptive)}); expected a boolean.`,
      );
    }
  }
  const rlr = config.maxRateLimitRetries;
  if (rlr != null) {
    if (typeof rlr === 'number' && Number.isInteger(rlr) && rlr >= 0) {
      limits.maxRateLimitRetries = rlr;
    } else {
      console.warn(
        `[axl] RateLimiter: ignoring invalid maxRateLimitRetries (${String(rlr)}); expected an integer >= 0. The default applies.`,
      );
    }
  }
  return limits;
}

/**
 * Counting semaphore + FIFO waiter queue. Dependency-free. Not shared across
 * processes — purely an in-process pacing aid.
 */
export class RateLimiter {
  // Mutable and protected so the internal per-scope governor can tighten a live
  // governor when a second provider block reaches the same scope.
  protected maxConcurrent = Infinity;
  protected minIntervalMs = 0;
  protected acquireTimeoutMs?: number;

  private active = 0;
  // `-Infinity` (not 0) so the FIRST grant is always immediate regardless of the
  // wall clock: `Date.now() - (-Infinity) === Infinity`, which always satisfies
  // `minIntervalMs`. Initializing to 0 would (only under a mocked/near-zero clock)
  // wrongly delay the first grant by a full interval, since the limiter has never
  // actually granted anything yet.
  private lastGrantAt = Number.NEGATIVE_INFINITY;
  private readonly queue: Waiter[] = [];
  private spacingTimer?: ReturnType<typeof setTimeout>;
  private warnedQueued = false;

  constructor(config: RateLimitConfig = {}) {
    this.applyLimits(sanitizeRateLimitConfig(config));
  }

  /**
   * Apply already-sanitized limits (see {@link sanitizeRateLimitConfig}). An
   * absent field means "no limit". Takes effect for the next grant; a waiter
   * already queued keeps the `acquireTimeoutMs` timer it was armed with.
   *
   * @internal Extension point for Axl's own per-scope governor; not a supported
   * public contract and may change without notice.
   */
  protected applyLimits(limits: RateLimitConfig): void {
    this.maxConcurrent = limits.maxConcurrent ?? Infinity;
    this.minIntervalMs = limits.minIntervalMs ?? 0;
    this.acquireTimeoutMs = limits.acquireTimeoutMs;
    this.pump();
  }

  /**
   * Acquire a permit. Resolves when one is granted (respecting `maxConcurrent`
   * and `minIntervalMs`). The caller MUST pair every resolved `acquire()` with
   * exactly one {@link release}.
   *
   * Abort handling:
   * - Pre-aborted signal ⇒ rejects immediately, no permit taken.
   * - Aborted while queued ⇒ spliced out of the queue, no counter change, rejects.
   * - (Once granted, the abort listener is removed — the holder owns the permit
   *   and releases it via `fetchWithRetry`'s `finally`.)
   *
   * With `acquireTimeoutMs`, a waiter that sits in the queue too long rejects.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    return this.enqueue(signal, { priority: false, timeoutMs: this.acquireTimeoutMs });
  }

  /**
   * Queue for a permit. A `priority` waiter goes ahead of every non-priority
   * waiter (FIFO among priority waiters) and never warns about queueing;
   * `timeoutMs` arms the fail-loud queue timeout (`undefined`: none).
   *
   * @internal Extension point for Axl's own per-scope governor (a retry's
   * re-acquire); not a supported public contract and may change without notice.
   */
  protected enqueue(
    signal: AbortSignal | undefined,
    options: { priority: boolean; timeoutMs: number | undefined },
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, priority: options.priority };

      if (signal) {
        waiter.onAbort = () => this.settleWaiter(waiter, signal.reason);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      // Capture the timeout this waiter is armed with: a pooled governor can be
      // tightened while it waits, and the message must name the value that fired.
      const timeoutMs = options.timeoutMs;
      if (timeoutMs != null) {
        waiter.timer = setTimeout(
          () =>
            this.settleWaiter(
              waiter,
              new Error(`RateLimiter.acquire timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }

      if (options.priority) {
        const firstOrdinary = this.queue.findIndex((w) => !w.priority);
        this.queue.splice(firstOrdinary === -1 ? this.queue.length : firstOrdinary, 0, waiter);
      } else {
        this.queue.push(waiter);
      }
      this.pump();

      // If pump() couldn't grant this waiter synchronously, it genuinely queued.
      // Warn only about the configured caps: a queue caused by something else
      // (a rate-limit brake on a pooled governor) is not a cap to raise.
      if (!waiter.granted && !options.priority && this.hasStaticCap() && !this.warnedQueued) {
        this.warnedQueued = true;
        console.warn(
          `[axl] RateLimiter: request queued (maxConcurrent=${this.maxConcurrent}${this.minIntervalMs ? `, minIntervalMs=${this.minIntervalMs}` : ''}). ` +
            `This is expected backpressure; lower fan-out or raise the cap if throughput suffers.`,
        );
      }
    });
  }

  private hasStaticCap(): boolean {
    return this.maxConcurrent !== Infinity || this.minIntervalMs > 0;
  }

  /**
   * Whether any caller is queued for a permit.
   *
   * @internal Extension point for Axl's own per-scope governor.
   */
  protected hasWaiters(): boolean {
    return this.queue.length > 0;
  }

  /** Release a previously acquired permit and wake the next waiter. */
  release(): void {
    if (this.active === 0) {
      // Never underflow `active` (that would permanently inflate effective
      // capacity). The one in-tree caller pairs acquire/release via an `acquired`
      // flag, so reaching here means a genuine double-release bug — surface it
      // loudly rather than silently corrupting the cap (repo's "fail loud" rule).
      console.warn(
        '[axl] RateLimiter.release() called with no active permits — likely a double-release bug.',
      );
      return;
    }
    this.active--;
    this.pump();
  }

  /** No-op; the per-scope governor overrides it to read quota headers. */
  observe(_res: Response): void {
    // intentionally empty
  }

  /**
   * Drain the queue: grant head waiters while a permit is free and spacing allows.
   * Protected so the internal per-scope governor can gate grants on its own
   * state (for example a brake) by overriding it.
   *
   * @internal Extension point for Axl's own per-scope governor; not a supported
   * public contract and may change without notice.
   */
  protected pump(): void {
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      if (this.minIntervalMs > 0) {
        const waitMs = this.minIntervalMs - (Date.now() - this.lastGrantAt);
        if (waitMs > 0) {
          // Head-of-line waits out the spacing interval. One shared timer re-pumps.
          if (!this.spacingTimer) {
            this.spacingTimer = setTimeout(() => {
              this.spacingTimer = undefined;
              this.pump();
            }, waitMs);
          }
          return;
        }
      }
      const waiter = this.queue.shift()!;
      this.grant(waiter);
    }
  }

  private grant(waiter: Waiter): void {
    waiter.settled = true;
    waiter.granted = true;
    this.active++;
    this.lastGrantAt = Date.now();
    this.clearWaiterTimers(waiter);
    waiter.resolve();
  }

  /** Reject a still-queued waiter (abort or timeout) and remove it cleanly. */
  private settleWaiter(waiter: Waiter, err: unknown): void {
    if (waiter.settled) return; // already granted/settled — nothing to do
    waiter.settled = true;
    const idx = this.queue.indexOf(waiter);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.clearWaiterTimers(waiter);
    waiter.reject(err);
    // A queued waiter never held a permit, so no release() is needed; but its
    // removal may unblock spacing/concurrency for others.
    this.pump();
  }

  private clearWaiterTimers(waiter: Waiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }
}
