/**
 * Retry wrapper for provider fetch calls.
 * Retries on rate-limit (429) and transient server errors (503, 529)
 * with exponential backoff, jitter, and Retry-After header support.
 */

import type { DispatchAdmission } from '../accounting.js';
import type { RateLimiter } from './rate-limiter.js';
import { ScopeGovernor } from './governor-pool.js';
import { classifySafely } from './quota.js';
import { buildProviderError, parseRetryAfter } from './errors.js';

/**
 * TRANSPORT auto-retry set. Deliberately NARROW ({429, 503, 529}) — these are
 * the statuses we auto-retry on the same provider with backoff. This is a
 * SEPARATE concept from `ProviderError.retryable` (the broader semantic
 * failover hint in `errors.ts` via `isRetryableStatus`): widening this set
 * would silently change auto-retry behavior for every provider. The subset
 * invariant (every member here is retryable per `isRetryableStatus`) is
 * asserted in tests. See the cross-link comment in `errors.ts`.
 *
 * `ReadonlySet` so in-package code can't mutate the invariant; intentionally NOT
 * barrel-exported — consumers use `ProviderError.retryable` / `isRetryableStatus`,
 * not this transport set.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 503, 529]);
const MAX_RETRIES = 2; // 3 total attempts
const BASE_DELAY_MS = 1000;
/** Cap an in-loop backoff sleep so a hostile/huge Retry-After can't stall us. */
const MAX_BACKOFF_MS = 60_000;

/** Apply +/-25% jitter to a backoff delay. */
function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Cancel the body of a response the retry loop is about to discard, so its
 * connection is released instead of held until garbage collection. Only for a
 * response the loop does NOT return: a returned response keeps its body for the
 * adapter's `res.text()` / `res.json()` (and so for `ProviderError.body`).
 *
 * Null-safe for bodyless fixtures. A rejected cancel (for example an already
 * locked stream) is ignored on purpose: releasing a discarded body is
 * best-effort cleanup, and failing the call over it would lose a retry that is
 * otherwise sound.
 */
function discardBody(res: Response): void {
  const cancelled = (res.body as { cancel?: () => unknown } | null | undefined)?.cancel?.();
  if (cancelled instanceof Promise) cancelled.catch(() => {});
}

/**
 * Transport-level timing for one {@link fetchWithRetry} call, reported to
 * `FetchWithRetryOptions.timing.onComplete` on the return path.
 *
 * All figures are `Date.now()` deltas / epoch stamps in milliseconds — the same
 * clock `agent_call_end.duration` uses.
 */
export type FetchTiming = {
  /**
   * Every self-imposed wait on the SDK's own governor: the first permit,
   * spacing, a rate-limit brake, and a re-acquire. `0` when no governor is set.
   */
  queuedMs: number;
  /** Requests actually sent, including the successful/final one (≥ 1). */
  attempts: number;
  /**
   * First attempt's dispatch → final attempt's dispatch, minus the part of
   * `queuedMs` inside that span, so the two are disjoint. `0` for a single attempt.
   */
  retryMs: number;
  /** Epoch ms at which the FINAL attempt's `fetch` was issued. */
  dispatchedAt: number;
  /** Epoch ms at which the final attempt's response headers arrived. */
  headersAt: number;
};

/** Options for {@link fetchWithRetry}. */
export type FetchWithRetryOptions = {
  /**
   * Max transient retries (503/529/network, and 429 off the adaptive path;
   * default 2 → 3 total attempts). Rate-limit 429s on an adaptive scope use the
   * governor's `maxRateLimitRetries` instead.
   */
  maxRetries?: number;
  /**
   * Optional rate governor. On the plain path (see {@link fetchWithRetry}) the
   * whole retry loop, including backoff sleeps, runs inside ONE acquired
   * permit, so backoff naturally applies backpressure to other waiters. On the
   * adaptive path (a pooled governor for an OpenAI or Anthropic scope) a
   * rate-limit 429 releases the permit, brakes the scope and re-acquires. Either
   * way the permit is released exactly once, gated on whether it is held.
   * Undefined ⇒ behavior is byte-identical to no governor.
   *
   * RE-ENTRANCY INVARIANT: a permit is held only across this single call. Do NOT
   * invoke another governed `fetchWithRetry` on the same governor while still
   * inside this one (before it returns/releases) — under `maxConcurrent: 1` that
   * self-deadlocks. Safe in the SDK today because nested `ctx.ask` calls run in
   * tool handlers AFTER the provider `chat()` returns and releases, never during
   * a `fetchWithRetry`.
   *
   * NOTE: a rejection from `governor.acquire()` (pre-aborted signal /
   * `acquireTimeoutMs`), and on the adaptive path from a brake wait or
   * re-acquire, propagates VERBATIM — every permit wait sits outside the
   * network-error `try`, so it is never normalized into a `ProviderError`.
   * Aborts must stay aborts.
   */
  governor?: RateLimiter;
  /**
   * Provider/adapter name used ONLY to label a normalized network error. When
   * `fetch` itself throws (DNS, connection reset, TLS, socket hangup) and
   * retries are exhausted, this becomes the `provider` field of the
   * `ProviderError{ status: 0 }` thrown. Defaults to `'unknown'`.
   */
  provider?: string;
  /**
   * Optional budget admission gate. `beforeDispatch` is called AFTER the
   * governor permit is acquired and immediately before EVERY `fetch` attempt —
   * so a request that queued behind the governor, or slept through retry
   * backoff, is re-checked against a budget that may have closed meanwhile.
   *
   * It is called OUTSIDE the network-error `try`, so throwing from it is not a
   * transport failure: the error is never normalized into a `ProviderError`,
   * never retried, and never mistaken for an abort. The permit is still
   * released by the existing `finally`.
   *
   * This is deliberately separate from `timing`, whose callbacks must not
   * throw and must not change behavior.
   */
  admission?: DispatchAdmission;
  /**
   * Optional out-of-band latency observer. Observing changes nothing: omitting
   * this leaves behavior byte-identical, and no callback's return value is read.
   *
   * A CALLBACK MUST NOT THROW. Each is invoked inside the fetch loop and none
   * is wrapped, so a throw propagates to the caller exactly as a
   * throwing `governor.observe()` does — the permit is still released by the
   * `finally`, but a throw from `onComplete` turns a returned `Response` into a
   * thrown error whose body is never consumed or cancelled. Propagating rather
   * than swallowing is deliberate and matches this seam's existing stance;
   * observers own their own error handling.
   */
  timing?: {
    /**
     * Fired at each attempt's `fetch` start, `attempt` 1-indexed. A stall clock
     * (Spec 23 `stallTimeout`) arms here, since this is the moment the request
     * actually leaves — after the governor grant and after any backoff sleep.
     */
    onDispatch?(attempt: number, at: number): void;
    /** Fired after a retryable response and before the SDK's backoff sleep. */
    onRetry?(attempt: number, at: number): void;
    /**
     * Fired exactly once, immediately before the final `Response` is returned
     * (OK, non-retryable, aborted-mid-retry, or retries exhausted). It does NOT
     * fire when the call throws — a normalized network failure or a propagated
     * abort loses its timing by design.
     *
     * It means "the transport returned a `Response`", NOT "the call succeeded".
     * A 4xx/5xx return fires it too, and the adapter then throws a
     * `ProviderError` and discards the figures. Never treat it as a success
     * signal.
     */
    onComplete?(timing: FetchTiming): void;
  };
};

/**
 * Distinguish a user/budget abort (which must propagate verbatim) from a real
 * transport failure (which we retry/normalize). A pre-aborted signal counts as
 * an abort even when the thrown error isn't a recognizable `AbortError`.
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Wrapper around fetch that retries on rate-limit and transient server errors
 * (429, 503, 529) with exponential backoff and jitter.
 * Returns the response as-is for non-retryable errors or after exhausting retries.
 *
 * **Plain path** (no governor, a directly constructed `RateLimiter`, or a pooled
 * governor that does not adapt): a permit is acquired before the loop and
 * released in `finally`, so the loop and its backoff hold the permit
 * throughout, and 429/503/529 share one budget (`maxRetries`). A
 * pre-aborted/rejected acquire throws before any permit is taken.
 *
 * **Adaptive path** (a pooled `ScopeGovernor` whose scope has a quota dialect,
 * `adaptive` not `false`): a 429 is classified from a byte-capped clone of
 * its body before anything else happens.
 * - A spend cap is returned at once with its body intact: no retry, no brake.
 * - Anything else is a rate limit. It brakes the whole scope for `Retry-After`
 *   (else the exponential backoff), clamped at {@link MAX_BACKOFF_MS}, and
 *   retries on its own budget (`maxRateLimitRetries`), releasing its permit
 *   for the wait and re-acquiring it ahead of first-time callers, exempt from
 *   `acquireTimeoutMs`. When that budget is spent the 429 is returned with
 *   its body intact.
 * - 503/529 and network failures keep the transient budget and hold the
 *   permit through their backoff, as on the plain path; a sleeper that wakes
 *   into a brake releases its permit before waiting it out.
 *
 * Invariants on the adaptive path: a permit is never held while waiting on a
 * brake (except a transient backoff that began before the brake, until it
 * wakes); the last `braked()` check comes after the permit is held with no
 * `await` between it and `fetch`; permit bookkeeping is always
 * `acquired = false → release() → wait → acquire → acquired = true`; a
 * brake-gate bounce dispatches nothing and consumes no budget; aborts reject
 * with `signal.reason`.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  const governor = opts?.governor;
  const scope = governor instanceof ScopeGovernor && governor.adapts ? governor : undefined;
  const provider = opts?.provider ?? 'unknown';
  const observer = opts?.timing;
  const signal = init?.signal ?? undefined;

  let acquired = false;
  // Self-imposed wait only: permit, spacing, brake and re-acquire waits in the
  // SDK's own governor. Without a governor there is nothing to wait on, so
  // `queuedMs` stays 0 rather than absorbing unrelated setup time.
  let queuedMs = 0;
  // The part of `queuedMs` spent after the first dispatch; subtracted from
  // `retryMs` so the two stay disjoint (a brake is queue time, not retry time).
  let queuedAfterFirstDispatchMs = 0;
  // Explicit counters. A brake-gate bounce increments none of them.
  let dispatches = 0;
  let rateLimitRetries = 0;
  let transientRetries = 0;
  let firstDispatchedAt = 0;
  let dispatchedAt = 0;
  let headersAt = 0;

  const waitSelfImposed = async (wait: () => Promise<void>): Promise<void> => {
    const start = Date.now();
    await wait();
    const waited = Date.now() - start;
    queuedMs += waited;
    if (dispatches > 0) queuedAfterFirstDispatchMs += waited;
  };
  const reportComplete = (): void => {
    observer?.onComplete?.({
      queuedMs,
      attempts: dispatches,
      retryMs: dispatchedAt - firstDispatchedAt - queuedAfterFirstDispatchMs,
      dispatchedAt,
      headersAt,
    });
  };

  if (governor && !scope) {
    // May reject (pre-aborted signal / acquireTimeoutMs) — propagate as the call
    // failure, BEFORE setting `acquired`, so `finally` never over-releases.
    await waitSelfImposed(() => governor.acquire(signal));
    acquired = true;
  }

  try {
    for (;;) {
      if (scope) {
        if (acquired) {
          // Still holding the permit through a transient backoff. An abort
          // during that sleep rejects with the signal's reason, like every
          // other wait on this path. (A brake that began during the sleep is
          // handled by the check below, with no await in between.)
          if (signal?.aborted) throw signal.reason;
        } else {
          // A first-time caller waits out any brake BEFORE queueing, so its
          // `acquireTimeoutMs` clock does not run during the brake. A retry
          // re-acquires at the head of the queue with no queue timeout; the
          // governor grants nothing until the brake ends. A wait that never
          // happens (not braked, permit free) is not timed at all, so it adds
          // exactly 0 to `queuedMs` rather than a clock tick.
          if (dispatches === 0 && scope.braked()) {
            await waitSelfImposed(() => scope.awaitClear(signal));
          }
          if (signal?.aborted) throw signal.reason;
          if (!scope.tryAcquire()) {
            await waitSelfImposed(() =>
              dispatches === 0 ? scope.acquire(signal) : scope.reacquire(signal),
            );
          }
          acquired = true;
        }
        // Last check, and the only place a held permit meets a brake: a
        // freshly granted caller, or a transient sleeper that woke into a
        // brake, gives its permit back and waits the brake out without it.
        // No `await` from here to `fetch`, so a brake set by another call
        // can't slip in between.
        if (scope.braked()) {
          acquired = false;
          scope.release();
          continue;
        }
      }

      dispatches++;
      // Budget gate before anything else in the attempt: after the governor
      // grant and after any backoff sleep, but before the request leaves. A
      // throw here propagates verbatim through the `finally` that releases the
      // permit — no retry, no ProviderError, no timing report.
      opts?.admission?.beforeDispatch(dispatches);
      dispatchedAt = Date.now();
      if (dispatches === 1) firstDispatchedAt = dispatchedAt;
      observer?.onDispatch?.(dispatches, dispatchedAt);
      let res: Response;
      try {
        // Never re-send provider request bodies or credentials to a redirect
        // target. A provider must be configured with its final endpoint.
        res = await fetch(input, { ...init, redirect: 'manual' });
      } catch (err) {
        // Network / non-HTTP failure (DNS, connection reset, TLS, socket
        // hangup). A user/budget abort must NEVER become a ProviderError —
        // propagate it verbatim.
        if (isAbortError(err, signal)) throw err;
        // Otherwise treat as a retryable transport failure on the transient
        // budget, and on exhaustion normalize to a ProviderError{ status: 0 }
        // (retryable via isRetryableStatus).
        if (transientRetries >= maxRetries) {
          throw buildProviderError({
            provider,
            status: 0,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        const backoffMs = BASE_DELAY_MS * 2 ** transientRetries;
        transientRetries++;
        observer?.onRetry?.(dispatches, Date.now());
        await sleep(jitter(backoffMs), signal);
        continue;
      }
      headersAt = Date.now();
      governor?.observe(res);

      if (scope && res.status === 429) {
        // Classify BEFORE braking: a spend cap must not hold up the scope.
        const kind = await classifySafely(scope.dialect!, res);
        if (kind === 'spend_cap') {
          reportComplete();
          return res;
        }
        // 'rate_limit' or 'unknown': brake every call on the scope.
        const retryAfterMs = parseRetryAfter(res.headers);
        const brakeMs =
          retryAfterMs !== undefined ? retryAfterMs : jitter(BASE_DELAY_MS * 2 ** rateLimitRetries);
        scope.brake(Math.min(brakeMs, MAX_BACKOFF_MS), dispatchedAt);
        if (rateLimitRetries >= scope.maxRateLimitRetries || signal?.aborted) {
          // Budget spent (or aborted): the body stays intact for ProviderError.body.
          reportComplete();
          return res;
        }
        rateLimitRetries++;
        observer?.onRetry?.(dispatches, Date.now());
        discardBody(res);
        acquired = false;
        scope.release();
        continue;
      }

      // Return immediately if OK, non-retryable, or out of retries
      if (res.ok || !RETRYABLE_STATUS_CODES.has(res.status) || transientRetries >= maxRetries) {
        reportComplete();
        return res;
      }

      // Don't retry if aborted
      if (signal?.aborted) {
        reportComplete();
        return res;
      }

      // Calculate delay: respect Retry-After header (shared parser, single
      // source of truth in errors.ts), else exponential backoff. Clamp the
      // in-loop sleep so a hostile/huge header can't stall the loop —
      // `ProviderError.retryAfterMs` still carries the RAW value.
      const retryAfterMs = parseRetryAfter(res.headers);
      const baseDelay =
        retryAfterMs !== undefined
          ? Math.min(retryAfterMs, MAX_BACKOFF_MS)
          : BASE_DELAY_MS * 2 ** transientRetries;
      transientRetries++;

      observer?.onRetry?.(dispatches, Date.now());
      // The loop continues with a new request, so this response is discarded:
      // release its connection now rather than when it is garbage-collected.
      discardBody(res);
      await sleep(jitter(baseDelay), signal);
    }
  } finally {
    if (acquired) governor!.release();
  }
}
