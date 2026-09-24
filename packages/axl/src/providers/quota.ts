/**
 * Quota dialects: how a first-party provider reports rate-limit headroom and
 * why it returned a 429.
 *
 * Only first-party OpenAI (the `openai` family, which covers both
 * `openai:` and `openai-responses:`) and Anthropic at the vendor's default
 * origin have a dialect. Every other scope (Gemini, OpenAI-compatible presets
 * such as Azure or OpenRouter, a first-party vendor behind a proxy) has none.
 * It still adapts (fleet brake, rate-limit retry budget, adaptive pacing; see
 * `governor-pool.ts`), but treats every 429 as a rate limit without reading
 * its body and never reads a quota hint. A preset gets a dialect only after
 * live evidence for its headers and 429 bodies.
 *
 * A dialect answers two questions:
 *
 * - {@link QuotaDialect.hint}: the smallest `remaining / limit` fraction over
 *   the vendor's documented quota lanes on a 2xx. It is a **conservative
 *   hint** only; the governor may use it to stop recovering, never to admit
 *   more. `reset` headers are never read, so no duration or timestamp parsing
 *   exists here.
 * - {@link QuotaDialect.classify429}: whether a 429 is an ordinary rate limit
 *   (wait and retry) or a spend cap (retrying cannot help until a human acts).
 *   It reads a byte-capped clone of the body so the adapter's own later
 *   `res.text()` still receives the raw body for `ProviderError.body`.
 *
 * Both are total over provider data: garbage header values and unparseable
 * bodies produce "no information" (`undefined` / `'unknown'`), never a throw.
 * The body is never logged.
 *
 * Internal: nothing here is barrel-exported.
 */
import { ANTHROPIC_DEFAULT_BASE_URL, OPENAI_DEFAULT_BASE_URL } from './default-endpoints.js';

/**
 * Why a 429 was returned. `'unknown'` means the body did not identify either
 * cause; the transport treats it as a rate limit, as it does every 429 on a
 * scope with no dialect.
 */
export type QuotaClass = 'rate_limit' | 'spend_cap' | 'unknown';

export type QuotaDialect = {
  /**
   * Minimum `remaining / limit` over the dialect's lanes, in `[0, 1]`, or
   * `undefined` when no lane is usable. Meant for 2xx responses.
   *
   * Total over header *values*. A `Headers` object whose `get` itself throws
   * is a broken input rather than provider data, so that throw propagates for
   * the governor's warn-once containment instead of being hidden here.
   */
  hint(headers: Headers): number | undefined;
  /**
   * Classify a 429 without consuming the original body. Never rejects:
   * a non-429, a response without `clone()` or a body, a failing read, or a
   * non-JSON body all yield `'unknown'`.
   */
  classify429(res: Response): Promise<QuotaClass>;
};

/**
 * The most bytes of a 429 body that classification reads. Vendor error bodies
 * are a few hundred bytes; the cap bounds work on a hostile or mislabeled
 * body. A body truncated at the cap no longer parses and classifies as
 * `'unknown'`.
 */
export const CLASSIFY_BODY_CAP_BYTES = 16 * 1024;

/** A non-negative decimal integer or fraction, nothing else (no sign, exponent, or list). */
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;

function parseQuotaNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!PLAIN_NUMBER.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

type Lane = { limit: string; remaining: string };

/**
 * Minimum usable `remaining / limit` over the lanes. A lane counts only with a
 * finite `limit > 0` and a finite `remaining >= 0`. The fraction is clamped to
 * 1: a `remaining` above `limit` (a stale or inconsistent pair) carries no more
 * headroom than a full lane, and a hint may never report more than "full".
 */
function minLaneFraction(headers: Headers, lanes: readonly Lane[]): number | undefined {
  let min: number | undefined;
  for (const lane of lanes) {
    const limit = parseQuotaNumber(headers.get(lane.limit));
    const remaining = parseQuotaNumber(headers.get(lane.remaining));
    if (limit === undefined || remaining === undefined || limit <= 0) continue;
    const fraction = Math.min(remaining / limit, 1);
    if (min === undefined || fraction < min) min = fraction;
  }
  return min;
}

/**
 * Read at most `cap` bytes of a clone of `res`'s body and parse them as JSON.
 * Cancels the clone's remaining stream so a large body is not buffered twice.
 * Returns `undefined` on any failure; the original response is untouched.
 */
async function readCappedJson(res: Response, cap: number): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    if (typeof res.clone !== 'function') return undefined;
    const body = res.clone().body;
    if (!body) return undefined;
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      const take = value.subarray(0, cap - total);
      chunks.push(take);
      total += take.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Missing/used body, a rejecting read, invalid JSON: no information.
    return undefined;
  } finally {
    if (reader && !finished) reader.cancel().catch(() => {});
  }
}

/** `body.error`, when the body is an object with an object `error` field. */
function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return undefined;
  return error as Record<string, unknown>;
}

function makeDialect(
  lanes: readonly Lane[],
  classifyBody: (error: Record<string, unknown>) => QuotaClass,
): QuotaDialect {
  return {
    hint: (headers) => minLaneFraction(headers, lanes),
    async classify429(res) {
      if (res.status !== 429) return 'unknown';
      const error = errorObject(await readCappedJson(res, CLASSIFY_BODY_CAP_BYTES));
      return error ? classifyBody(error) : 'unknown';
    },
  };
}

/**
 * OpenAI `error.code` values that mean billing, spend, or quota exhaustion
 * (developers.openai.com/api/docs/guides/error-codes, 2026-09-22: "Retrying
 * billing, spend, or quota errors won't restore API access"). The page adds
 * that for these "the broader `error.type` can still be `insufficient_quota`",
 * which is matched separately. `insufficient_quota` as a *code* is the legacy
 * shape and is kept for older accounts. Live bodies are unverified (plan §8 L3).
 */
const OPENAI_SPEND_CAP_CODES: ReadonlySet<unknown> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);

/**
 * Lanes from developers.openai.com/api/docs/guides/rate-limits, including the
 * project-scoped token lane. More lanes only lower the minimum, which keeps the
 * hint conservative.
 */
export const openaiQuotaDialect: QuotaDialect = makeDialect(
  [
    { limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests' },
    { limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens' },
    {
      limit: 'x-ratelimit-limit-project-tokens',
      remaining: 'x-ratelimit-remaining-project-tokens',
    },
  ],
  (error) => {
    if (error.type === 'insufficient_quota' || OPENAI_SPEND_CAP_CODES.has(error.code)) {
      return 'spend_cap';
    }
    // Documented rate-limit 429s (for example `slow_down`) carry this type.
    if (error.type === 'rate_limit_error') return 'rate_limit';
    return 'unknown';
  },
);

/**
 * Lanes and spend-cap shape from platform.claude.com/docs/en/api/rate-limits.
 * The spend-cap 429 has `error.type: 'rate_limit_error'`, the same as a rate
 * limit, and no `retry-after`; only `error.details.error_code` tells them
 * apart. `remaining` token values are rounded to the nearest 1,000, which is
 * acceptable for a conservative hint.
 */
export const anthropicQuotaDialect: QuotaDialect = makeDialect(
  [
    {
      limit: 'anthropic-ratelimit-requests-limit',
      remaining: 'anthropic-ratelimit-requests-remaining',
    },
    {
      limit: 'anthropic-ratelimit-tokens-limit',
      remaining: 'anthropic-ratelimit-tokens-remaining',
    },
    {
      limit: 'anthropic-ratelimit-input-tokens-limit',
      remaining: 'anthropic-ratelimit-input-tokens-remaining',
    },
    {
      limit: 'anthropic-ratelimit-output-tokens-limit',
      remaining: 'anthropic-ratelimit-output-tokens-remaining',
    },
    // Priority Tier only; absent otherwise.
    {
      limit: 'anthropic-priority-input-tokens-limit',
      remaining: 'anthropic-priority-input-tokens-remaining',
    },
    {
      limit: 'anthropic-priority-output-tokens-limit',
      remaining: 'anthropic-priority-output-tokens-remaining',
    },
  ],
  (error) => {
    const details = error.details;
    if (
      typeof details === 'object' &&
      details !== null &&
      (details as Record<string, unknown>).error_code === 'enforced_spend_limit_reached'
    ) {
      return 'spend_cap';
    }
    if (error.type === 'rate_limit_error') return 'rate_limit';
    return 'unknown';
  },
);

/**
 * Keyed by governor-scope family (`governor-pool.ts`); a Map so no prototype key
 * resolves. Each dialect describes its vendor's own endpoint only, so it is paired
 * with the origin of the adapters' default base URL.
 */
const DIALECTS: ReadonlyMap<string, { origin: string; dialect: QuotaDialect }> = new Map([
  ['openai', { origin: new URL(OPENAI_DEFAULT_BASE_URL).origin, dialect: openaiQuotaDialect }],
  [
    'anthropic',
    { origin: new URL(ANTHROPIC_DEFAULT_BASE_URL).origin, dialect: anthropicQuotaDialect },
  ],
]);

/**
 * The dialect for a governor scope, or `undefined` for a dialect-less scope.
 *
 * A dialect applies only at its vendor's own endpoint. `origin` is the scope's
 * normalized origin (`new URL(baseUrl).origin`); an `openai` or `anthropic`
 * block pointed at a proxy, gateway or self-hosted server gets no dialect,
 * because that server's 429s and headers are not the vendor's.
 */
export function quotaDialectFor(family: string, origin: string): QuotaDialect | undefined {
  const entry = DIALECTS.get(family);
  return entry !== undefined && entry.origin === origin ? entry.dialect : undefined;
}

/**
 * Classify a 429 through `dialect`, containing any rejection or throw as
 * `'unknown'`. The built-in dialects never reject; this is the transport's
 * guarantee that classification can never fail a call on its own.
 */
export async function classifySafely(dialect: QuotaDialect, res: Response): Promise<QuotaClass> {
  try {
    return await dialect.classify429(res);
  } catch {
    return 'unknown';
  }
}
