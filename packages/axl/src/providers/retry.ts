/**
 * Retry wrapper for provider fetch calls.
 * Retries on rate-limit (429) and transient server errors (503, 529)
 * with exponential backoff, jitter, and Retry-After header support.
 */

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

/**
 * Wrapper around fetch that retries on rate-limit and transient server errors
 * (429, 503, 529) with exponential backoff and jitter.
 * Returns the response as-is for non-retryable errors or after exhausting retries.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);

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
}
