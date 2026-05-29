/**
 * Retry wrapper for provider fetch calls.
 * Retries on rate-limit (429) and transient server errors (503, 529)
 * with exponential backoff, jitter, and Retry-After header support.
 */

import type { RateLimiter } from './rate-limiter.js';

const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);
const MAX_RETRIES = 2; // 3 total attempts
const BASE_DELAY_MS = 1000;

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
   */
  governor?: RateLimiter;
};

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

  let acquired = false;
  if (governor) {
    // May reject (pre-aborted signal / acquireTimeoutMs) — propagate as the call
    // failure, BEFORE setting `acquired`, so `finally` never over-releases.
    await governor.acquire(init?.signal ?? undefined);
    acquired = true;
  }

  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(input, init);
      governor?.observe(res);

      // Return immediately if OK, non-retryable, or out of retries
      if (res.ok || !RETRYABLE_STATUS_CODES.has(res.status) || attempt >= maxRetries) {
        return res;
      }

      // Don't retry if aborted
      if (init?.signal?.aborted) {
        return res;
      }

      // Calculate delay: respect Retry-After header, else exponential backoff
      const retryAfter = res.headers.get('retry-after');
      let delay: number;
      if (retryAfter && !isNaN(Number(retryAfter))) {
        delay = Number(retryAfter) * 1000;
      } else {
        delay = BASE_DELAY_MS * 2 ** attempt;
      }
      // Jitter: +/-25%
      delay *= 0.75 + Math.random() * 0.5;

      await sleep(delay, init?.signal ?? undefined);
    }
  } finally {
    if (acquired) governor!.release();
  }
}
