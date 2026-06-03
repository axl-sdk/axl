/**
 * Typed provider errors + shared HTTP-failure classification.
 *
 * Every adapter's `if (!res.ok)` site throws a {@link ProviderError} (built via
 * {@link buildProviderError}) instead of a bare `Error`, and `fetchWithRetry`
 * normalizes thrown network failures (DNS, reset, TLS) into a `ProviderError`
 * with `status: 0`. The `.message` text is preserved verbatim from each
 * adapter's own `extractErrorMessage`, so existing `.message` assertions keep
 * working — only the thrown *type* changes.
 *
 * RETRY MODEL — two SEPARATE sets (do not conflate):
 *  - `ProviderError.retryable` (here, via {@link isRetryableStatus}) is the
 *    BROADER *semantic failover hint* for higher layers (e.g. "should I try a
 *    different model/provider?"). It is NOT consulted by the transport loop.
 *  - `retry.ts`'s `RETRYABLE_STATUS_CODES` ({429, 503, 529}) is the NARROW
 *    *transport auto-retry* set. It stays narrow on purpose — widening it would
 *    silently change auto-retry for every provider. See the cross-link comment
 *    there.
 *
 * This module must NOT import `retry.ts` (retry.ts imports `parseRetryAfter`
 * from here — keep the dependency one-way to avoid a cycle).
 */

import { AxlError } from '../errors.js';

/**
 * Error thrown by provider adapters on any non-2xx HTTP response, and by
 * `fetchWithRetry` on an exhausted/normalized network failure (`status: 0`).
 *
 * `instanceof Error` and `instanceof AxlError` both hold; `code` is always
 * `'PROVIDER_ERROR'`. The constructor message is passed through verbatim (no
 * prefix) so callers asserting on the raw provider message are unaffected.
 */
export class ProviderError extends AxlError {
  /** Adapter/profile name, e.g. `'openai'`, `'anthropic'`, `'google'`. */
  readonly provider: string;
  /** HTTP status code; `0` for non-HTTP (network) failures. */
  readonly status: number;
  /** Semantic failover hint (see module doc) — NOT the transport-retry set. */
  readonly retryable: boolean;
  /** Parsed `Retry-After` delay in ms (RAW/unclamped), when the header was present. */
  readonly retryAfterMs?: number;
  /** Provider request id from response headers, when present. */
  readonly requestId?: string;
  /**
   * Raw provider error body. Lives ONLY on the error object — it is
   * intentionally never placed on the event stream (it can echo prompt text
   * and is redaction-eligible). See `docs/security.md`.
   */
  readonly body?: string;

  constructor(args: {
    provider: string;
    status: number;
    retryable: boolean;
    message: string;
    retryAfterMs?: number;
    requestId?: string;
    body?: string;
  }) {
    // Message passed VERBATIM — no prefix. Existing `.message` assertions on
    // adapter `extractErrorMessage` output must not break.
    super('PROVIDER_ERROR', args.message);
    this.name = 'ProviderError';
    this.provider = args.provider;
    this.status = args.status;
    this.retryable = args.retryable;
    this.retryAfterMs = args.retryAfterMs;
    this.requestId = args.requestId;
    this.body = args.body;
  }
}

/**
 * Classify an HTTP status as a semantic failover hint (see {@link ProviderError}).
 *
 * Grounded in observed provider behavior. Unmapped codes default to `false`
 * (conservative); add a row only for a status we've observed a real provider
 * emit. Status `0` (non-HTTP / network failure) is retryable.
 */
export function isRetryableStatus(status: number): boolean {
  switch (status) {
    case 0: // network / non-HTTP failure (built by fetchWithRetry on exhaustion)
      return true;
    case 408: // request timeout
    case 429: // rate limit
    case 500:
    case 502:
    case 503:
    case 504:
    case 529: // Anthropic "overloaded"
      return true;
    // Explicitly non-retryable (bad request / auth / not found / payload):
    // 400, 401, 403, 404, 413, 422 fall through to the default.
    default:
      // Conservative default — includes other 4xx like 409 (conflict) and
      // 425 (too early): a cross-provider catalog-miss / conflict failover is
      // a higher-layer policy decision, not a transport-level retry hint.
      return false;
  }
}

/**
 * Parse a `Retry-After` header into milliseconds. SINGLE source of truth for
 * both the in-loop transport sleep (clamped by the caller) and
 * `ProviderError.retryAfterMs` (raw).
 *
 * Supports both forms of the header:
 *  - delay-seconds: `Retry-After: 120` → `120_000`
 *  - HTTP-date:     `Retry-After: <http-date>` → `Date.parse(v) - Date.now()`
 *
 * Returns the RAW parsed ms (NOT clamped). Negative, zero, or unparseable
 * values → `undefined`.
 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const trimmed = raw.trim();

  // delay-seconds form: a bare (non-negative) number.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 ? ms : undefined;
  }

  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : undefined;
}

/**
 * Headers that providers use to surface a request id. First present wins.
 * `x-request-id` is emitted by OpenAI, Anthropic and OpenAI-compatible gateways;
 * `request-id` is an Anthropic alias. Gemini does not expose a standard one — we
 * omit `requestId` rather than guess when none of these is present.
 */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id'] as const;

function extractRequestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Construct a {@link ProviderError} from a non-2xx response (or a normalized
 * network failure). Classifies `retryable` via {@link isRetryableStatus} and,
 * when `headers` are present, extracts `retryAfterMs` ({@link parseRetryAfter})
 * and `requestId`.
 */
export function buildProviderError(args: {
  provider: string;
  status: number;
  headers?: Headers;
  message: string;
  body?: string;
}): ProviderError {
  return new ProviderError({
    provider: args.provider,
    status: args.status,
    retryable: isRetryableStatus(args.status),
    message: args.message,
    retryAfterMs: args.headers ? parseRetryAfter(args.headers) : undefined,
    requestId: args.headers ? extractRequestId(args.headers) : undefined,
    body: args.body,
  });
}
