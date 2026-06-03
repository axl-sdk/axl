import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProviderError,
  isRetryableStatus,
  parseRetryAfter,
  buildProviderError,
} from '../providers/errors.js';
import { fetchWithRetry, RETRYABLE_STATUS_CODES } from '../providers/retry.js';
import { AxlError } from '../errors.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIEmbedder } from '../memory/embedder-openai.js';
import type { ChatMessage, ChatOptions } from '../providers/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A non-2xx Response factory. `text()` returns the raw body once (matches the
// single `await res.text()` at each adapter throw site).
function errorResponse(status: number, body: string, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const OPTS: ChatOptions = { model: 'm', maxTokens: 16 };

// ---------------------------------------------------------------------------
// B3 — isRetryableStatus classification table
// ---------------------------------------------------------------------------
describe('isRetryableStatus (B3 table)', () => {
  const retryable = [0, 408, 429, 500, 502, 503, 504, 529];
  const nonRetryable = [400, 401, 403, 404, 409, 413, 422, 425];

  it.each(retryable)('%i → true', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each(nonRetryable)('%i → false (incl. conservative 409/425 default)', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });

  it('unmapped 4xx (418) → false (conservative default)', () => {
    expect(isRetryableStatus(418)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2/S1/S2 — parseRetryAfter
// ---------------------------------------------------------------------------
describe('parseRetryAfter', () => {
  it('numeric seconds → ms', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }))).toBe(2000);
  });

  it('fractional numeric seconds → ms', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }))).toBe(1500);
  });

  it('valid future HTTP-date → ms-until-then (within tolerance)', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter(new Headers({ 'retry-after': future }));
    expect(parsed).toBeGreaterThan(25_000);
    expect(parsed).toBeLessThanOrEqual(31_000);
  });

  it('past HTTP-date → undefined (negative delta)', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(new Headers({ 'retry-after': past }))).toBeUndefined();
  });

  it('negative seconds → undefined (not numeric per the strict regex)', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '-5' }))).toBeUndefined();
  });

  it('zero seconds → undefined', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '0' }))).toBeUndefined();
  });

  it('garbage string → undefined', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon-ish' }))).toBeUndefined();
  });

  it('missing header → undefined', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B1/B4 — backward-compat + subset invariant
// ---------------------------------------------------------------------------
describe('ProviderError backward-compat', () => {
  it('is instanceof Error AND AxlError; code is PROVIDER_ERROR', () => {
    const err = new ProviderError({
      provider: 'openai',
      status: 401,
      retryable: false,
      message: 'OpenAI API error (401): bad key',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AxlError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.name).toBe('ProviderError');
  });

  it('message is verbatim (no prefix)', () => {
    const msg = 'Anthropic API error (429): rate limited';
    const err = buildProviderError({ provider: 'anthropic', status: 429, message: msg });
    expect(err.message).toBe(msg);
  });

  it('buildProviderError classifies retryable + carries fields', () => {
    const headers = new Headers({ 'retry-after': '3', 'x-request-id': 'req_abc' });
    const err = buildProviderError({
      provider: 'openai',
      status: 503,
      headers,
      message: 'down',
      body: '{"error":{"message":"down"}}',
    });
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.requestId).toBe('req_abc');
    expect(err.body).toBe('{"error":{"message":"down"}}');
  });

  it('request-id alias header is also picked up', () => {
    const err = buildProviderError({
      provider: 'anthropic',
      status: 500,
      headers: new Headers({ 'request-id': 'req_xyz' }),
      message: 'oops',
    });
    expect(err.requestId).toBe('req_xyz');
  });

  it('no standard request-id header → requestId undefined (not guessed)', () => {
    const err = buildProviderError({
      provider: 'google',
      status: 500,
      headers: new Headers(),
      message: 'oops',
    });
    expect(err.requestId).toBeUndefined();
  });

  it('subset invariant (B4): every transport-retry code is isRetryableStatus', async () => {
    // Iterate the ACTUAL exported transport set — a real cross-file guard, so
    // widening RETRYABLE_STATUS_CODES with a non-retryable status fails here.
    for (const status of RETRYABLE_STATUS_CODES) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — per-adapter throw sites (chat + stream)
// ---------------------------------------------------------------------------
type AdapterCase = {
  name: string;
  provider: string;
  make: () => {
    chat: (m: ChatMessage[], o: ChatOptions) => Promise<unknown>;
    stream: (m: ChatMessage[], o: ChatOptions) => AsyncGenerator<unknown>;
  };
  // A status-specific error body in the provider's own JSON shape.
  body: (status: number) => string;
  // The expected verbatim message for a given status.
  expectedMessage: (status: number, detail: string) => string;
  detail: string;
};

const ADAPTERS: AdapterCase[] = [
  {
    name: 'OpenAIProvider',
    provider: 'openai',
    make: () => new OpenAIProvider({ apiKey: 'sk-test' }),
    body: () => JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }),
    expectedMessage: (status, detail) => `OpenAI API error (${status}): ${detail}`,
    detail: 'invalid api key',
  },
  {
    name: 'OpenAIResponsesProvider',
    provider: 'openai-responses',
    make: () => new OpenAIResponsesProvider({ apiKey: 'sk-test' }),
    body: () => JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }),
    expectedMessage: (status, detail) => `OpenAI Responses API error (${status}): ${detail}`,
    detail: 'invalid api key',
  },
  {
    name: 'AnthropicProvider',
    provider: 'anthropic',
    make: () => new AnthropicProvider({ apiKey: 'sk-ant-test' }),
    body: () => JSON.stringify({ error: { message: 'overloaded', type: 'overloaded_error' } }),
    expectedMessage: (status, detail) => `Anthropic API error (${status}): ${detail}`,
    detail: 'overloaded',
  },
  {
    name: 'GeminiProvider',
    provider: 'google',
    make: () => new GeminiProvider({ apiKey: 'gk-test' }),
    body: () => JSON.stringify({ error: { message: 'permission denied', code: 403 } }),
    expectedMessage: (status, detail) => `Gemini API error (${status}): ${detail}`,
    detail: 'permission denied',
  },
];

describe.each(ADAPTERS)('$name throws ProviderError', (tc) => {
  // NOTE: statuses chosen so the adapter throws WITHOUT entering the transport
  // retry loop (429/503/529 would trigger real backoff sleeps). 500 is
  // retryable-by-classification but NOT in the transport-retry set, so it
  // throws immediately. The 429→retry→throw path is covered with fake timers
  // in the "transport ↔ typed error compose" block below.
  it.each([
    [401, false],
    [500, true],
  ])('chat: status %i → ProviderError{retryable:%s}', async (status, retryable) => {
    const body = tc.body(status);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(status, body, { 'x-request-id': 'rid-1' })),
    );
    const adapter = tc.make();
    try {
      await adapter.chat(MESSAGES, OPTS);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.provider).toBe(tc.provider);
      expect(pe.status).toBe(status);
      expect(pe.retryable).toBe(retryable);
      expect(pe.message).toBe(tc.expectedMessage(status, tc.detail));
      expect(pe.body).toBe(body);
    }
  });

  it('stream: 401 → ProviderError before yielding', async () => {
    const body = tc.body(401);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, body)));
    const adapter = tc.make();
    const gen = adapter.stream(MESSAGES, OPTS);
    try {
      await gen.next();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.provider).toBe(tc.provider);
      expect(pe.status).toBe(401);
      expect(pe.retryable).toBe(false);
      expect(pe.message).toBe(tc.expectedMessage(401, tc.detail));
    }
  });

  it('stream: a network failure normalizes to ProviderError{status:0} too', async () => {
    // The stream() site routes through the same fetchWithRetry; a thrown fetch
    // must surface as a status:0 ProviderError, not a raw TypeError. Fake timers
    // skip the transport backoff between the default retries.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('socket hangup'))),
    );
    const adapter = tc.make();
    const settle = adapter
      .stream(MESSAGES, OPTS)
      .next()
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    await vi.runAllTimersAsync();
    const outcome = await settle;
    expect(outcome.ok).toBe(false);
    const pe = (outcome as { e: unknown }).e;
    expect(pe).toBeInstanceOf(ProviderError);
    expect((pe as ProviderError).status).toBe(0);
    expect((pe as ProviderError).retryable).toBe(true);
    expect((pe as ProviderError).provider).toBe(tc.provider);
  });
});

describe('Retry-After surfaced on a thrown ProviderError', () => {
  it('numeric header → retryAfterMs populated', () => {
    // Adapters pass `res.headers` straight into buildProviderError; assert the
    // header→field mapping directly (the adapter wiring is covered above).
    const err = buildProviderError({
      provider: 'openai',
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      message: 'slow down',
    });
    expect(err.retryAfterMs).toBe(5000);
  });

  it('HTTP-date header → retryAfterMs populated', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const err = buildProviderError({
      provider: 'openai',
      status: 503,
      headers: new Headers({ 'retry-after': future }),
      message: 'down',
    });
    expect(err.retryAfterMs).toBeGreaterThan(5_000);
  });

  it('absent header → retryAfterMs undefined', () => {
    const err = buildProviderError({
      provider: 'openai',
      status: 503,
      headers: new Headers(),
      message: 'down',
    });
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B2a / B5 / B6 — transport + typed compose via fetchWithRetry
// ---------------------------------------------------------------------------
describe('fetchWithRetry transport ↔ typed error compose', () => {
  it('503 retried maxRetries times then RETURNS the response (transport set unchanged)', async () => {
    // 503 is in the transport-retry set: fetchWithRetry returns the final
    // non-ok Response (it does NOT throw) — the ADAPTER turns it into a
    // ProviderError at the !res.ok site. Keep backoff short: no retry-after,
    // small maxRetries, fake timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(503, 'overloaded'));
    vi.stubGlobal('fetch', fetchFn);

    const p = fetchWithRetry('https://x', undefined, { maxRetries: 2, provider: 'openai' });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('adapter: a 503 surfaces as ProviderError{status:503, retryable:true}', async () => {
    // Default maxRetries on the adapter path; use fake timers to skip backoff.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const body = JSON.stringify({ error: { message: 'overloaded' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(503, body)));
    const adapter = new OpenAIProvider({ apiKey: 'sk-test' });

    const call = adapter.chat(MESSAGES, OPTS);
    const settle = call.then(
      () => ({ ok: true }),
      (e) => ({ ok: false, e }),
    );
    await vi.runAllTimersAsync();
    const outcome = (await settle) as { ok: boolean; e?: unknown };
    expect(outcome.ok).toBe(false);
    expect(outcome.e).toBeInstanceOf(ProviderError);
    expect((outcome.e as ProviderError).status).toBe(503);
    expect((outcome.e as ProviderError).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B2a — network path normalization
// ---------------------------------------------------------------------------
describe('fetchWithRetry network normalization', () => {
  it('persistent fetch rejection → ProviderError{status:0, retryable:true} after exhaustion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetchFn);

    const settle = fetchWithRetry('https://x', undefined, {
      maxRetries: 2,
      provider: 'anthropic',
    }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, e }),
    );
    await vi.runAllTimersAsync();
    const outcome = (await settle) as { ok: boolean; e?: unknown };
    expect(outcome.ok).toBe(false);
    expect(outcome.e).toBeInstanceOf(ProviderError);
    const pe = outcome.e as ProviderError;
    expect(pe.status).toBe(0);
    expect(pe.retryable).toBe(true);
    expect(pe.provider).toBe('anthropic');
    expect(pe.message).toBe('fetch failed');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('AbortError-shaped DOMException propagates UNCHANGED (never wrapped)', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(abortErr)),
    );

    await expect(
      fetchWithRetry('https://x', undefined, { maxRetries: 2, provider: 'openai' }),
    ).rejects.toBe(abortErr);
  });

  it('aborted signal: a thrown error during abort propagates, not wrapped', async () => {
    const controller = new AbortController();
    controller.abort();
    // Even a generic Error counts as abort when signal.aborted is true.
    const genericErr = new Error('socket closed by abort');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(genericErr)),
    );

    await expect(
      fetchWithRetry('https://x', { signal: controller.signal }, { provider: 'openai' }),
    ).rejects.toBe(genericErr);
  });

  it('transient rejection then success → recovers (no ProviderError)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ok = new Response('{}', { status: 200 });
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError('reset')).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchFn);

    const p = fetchWithRetry('https://x', undefined, { maxRetries: 2, provider: 'openai' });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// OpenAIEmbedder participates in the same typed-error contract (it routes
// through fetchWithRetry, so the network path was already affected; its own
// !res.ok site now throws ProviderError too, for consistency).
// ---------------------------------------------------------------------------
describe('OpenAIEmbedder throws ProviderError', () => {
  it('non-2xx → ProviderError{provider:openai} with verbatim message', async () => {
    // 400 (not in the transport-retry set) so the adapter throws immediately —
    // no real backoff. The retryable classification itself is covered by the
    // isRetryableStatus table above.
    const body = JSON.stringify({ error: { message: 'invalid input' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400, body)));
    const embedder = new OpenAIEmbedder({ apiKey: 'sk-test' });
    try {
      await embedder.embed(['hello']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.provider).toBe('openai');
      expect(pe.status).toBe(400);
      expect(pe.retryable).toBe(false);
      // Message extracts the nested error.message (parity with adapters)…
      expect(pe.message).toBe('OpenAI embeddings API error (400): invalid input');
      // …while the raw body is still preserved on the error.
      expect(pe.body).toBe(body);
    }
  });

  it('network failure → ProviderError{status:0, provider:openai}', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('dns failure'))),
    );
    const embedder = new OpenAIEmbedder({ apiKey: 'sk-test' });
    const settle = embedder.embed(['hello']).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settle;
    expect(outcome.ok).toBe(false);
    const pe = (outcome as { e: unknown }).e;
    expect(pe).toBeInstanceOf(ProviderError);
    expect((pe as ProviderError).status).toBe(0);
    expect((pe as ProviderError).provider).toBe('openai');
  });
});
