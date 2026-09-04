/**
 * Retry wrapper for provider fetch calls.
 * Retries on rate-limit (429) and transient server errors (503, 529)
 * with exponential backoff, jitter, and Retry-After header support.
 */

import type { RateLimiter } from './rate-limiter.js';
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
 * Transport-level timing for one {@link fetchWithRetry} call, reported to
 * `FetchWithRetryOptions.timing.onComplete` on the return path.
 *
 * All figures are `Date.now()` deltas / epoch stamps in milliseconds — the same
 * clock `agent_call_end.duration` uses.
 */
export type FetchTiming = {
  /** Time spent waiting on the SDK's own governor. `0` when no governor is set. */
  queuedMs: number;
  /** Total `fetch` attempts made, including the successful/final one (≥ 1). */
  attempts: number;
  /** First attempt's dispatch → final attempt's dispatch. `0` for a single attempt. */
  retryMs: number;
  /** Epoch ms at which the FINAL attempt's `fetch` was issued. */
  dispatchedAt: number;
  /** Epoch ms at which the final attempt's response headers arrived. */
  headersAt: number;
};

/** Options for {@link fetchWithRetry}. */
export type FetchWithRetryOptions = {
  /** Max retries on a retryable status (default 2 → 3 total attempts). */
  maxRetries?: number;
  /**
   * Optional rate governor. When set, the whole retry loop (including backoff
   * sleeps) runs inside ONE acquired permit, so backoff naturally applies
   * backpressure to other waiters; the permit is released exactly once in
   * `finally`, gated on whether it was actually acquired. Undefined ⇒ behavior
   * is byte-identical to no governor.
   *
   * RE-ENTRANCY INVARIANT: a permit is held only across this single call. Do NOT
   * invoke another governed `fetchWithRetry` on the same governor while still
   * inside this one (before it returns/releases) — under `maxConcurrent: 1` that
   * self-deadlocks. Safe in the SDK today because nested `ctx.ask` calls run in
   * tool handlers AFTER the provider `chat()` returns and releases, never during
   * a `fetchWithRetry`.
   *
   * NOTE: a rejection from `governor.acquire()` (pre-aborted signal /
   * `acquireTimeoutMs`) propagates VERBATIM — it is raised before the fetch loop,
   * so it is never normalized into a `ProviderError`. Aborts must stay aborts.
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
   * Optional out-of-band latency observer. Observing changes nothing: omitting
   * this leaves behavior byte-identical, and neither callback's return value is
   * read.
   *
   * A CALLBACK MUST NOT THROW. Both are invoked inside the fetch loop and
   * neither is wrapped, so a throw propagates to the caller exactly as a
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
 * When `opts.governor` is set, a permit is acquired before the loop and released
 * in `finally` — so the loop (and its backoff) holds the permit for its whole
 * duration. A pre-aborted/rejected acquire throws before any permit is taken
 * (and the `acquired` flag prevents an over-release).
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  const governor = opts?.governor;
  const provider = opts?.provider ?? 'unknown';
  const observer = opts?.timing;

  let acquired = false;
  // Self-imposed wait only. Without a governor there is nothing to wait on, so
  // `queuedMs` stays 0 rather than absorbing unrelated setup time.
  let queuedMs = 0;
  if (governor) {
    const acquireStart = Date.now();
    // May reject (pre-aborted signal / acquireTimeoutMs) — propagate as the call
    // failure, BEFORE setting `acquired`, so `finally` never over-releases.
    await governor.acquire(init?.signal ?? undefined);
    acquired = true;
    queuedMs = Date.now() - acquireStart;
  }

  let firstDispatchedAt = 0;
  let dispatchedAt = 0;
  let headersAt = 0;
  const reportComplete = (attempts: number): void => {
    observer?.onComplete?.({
      queuedMs,
      attempts,
      retryMs: dispatchedAt - firstDispatchedAt,
      dispatchedAt,
      headersAt,
    });
  };

  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      dispatchedAt = Date.now();
      if (attempt === 0) firstDispatchedAt = dispatchedAt;
      observer?.onDispatch?.(attempt + 1, dispatchedAt);
      try {
        // Never re-send provider request bodies or credentials to a redirect
        // target. A provider must be configured with its final endpoint.
        res = await fetch(input, { ...init, redirect: 'manual' });
      } catch (err) {
        // Network / non-HTTP failure (DNS, connection reset, TLS, socket
        // hangup). A user/budget abort must NEVER become a ProviderError —
        // propagate it verbatim.
        if (isAbortError(err, init?.signal ?? undefined)) throw err;
        // Otherwise treat as a retryable transport failure: retry with the same
        // backoff path as 429/503/529, and on exhaustion normalize to a
        // ProviderError{ status: 0 } (retryable via isRetryableStatus).
        if (attempt >= maxRetries) {
          throw buildProviderError({
            provider,
            status: 0,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        await sleep(jitter(BASE_DELAY_MS * 2 ** attempt), init?.signal ?? undefined);
        continue;
      }
      headersAt = Date.now();
      governor?.observe(res);

      // Return immediately if OK, non-retryable, or out of retries
      if (res.ok || !RETRYABLE_STATUS_CODES.has(res.status) || attempt >= maxRetries) {
        reportComplete(attempt + 1);
        return res;
      }

      // Don't retry if aborted
      if (init?.signal?.aborted) {
        reportComplete(attempt + 1);
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
          : BASE_DELAY_MS * 2 ** attempt;

      await sleep(jitter(baseDelay), init?.signal ?? undefined);
    }
  } finally {
    if (acquired) governor!.release();
  }
}
