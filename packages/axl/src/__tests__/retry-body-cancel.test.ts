import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../providers/retry.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { OpenAIProvider } from '../providers/openai.js';
import { ProviderError } from '../providers/errors.js';

// AC28: a retried 429/503/529 response's body is cancelled before the loop
// sleeps, so the connection is released instead of leaking until GC. A
// RETURNED response (success, non-retryable, or retries exhausted) keeps its
// body for the adapter's `res.text()` / `res.json()`.

const originalFetch = globalThis.fetch;
// Captured before fake timers replace it.
const realSetImmediate = globalThis.setImmediate;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor 1.0
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(status: number, text = '') {
  const cancel = vi.fn(() => Promise.resolve());
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: { cancel },
    text: vi.fn(async () => text),
    json: vi.fn(async () => JSON.parse(text)),
    cancel,
  };
}

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe('AC28: retried response bodies are cancelled', () => {
  it.each([429, 503, 529])(
    '%i → 200: the retried body is cancelled, the returned one is not',
    async (status) => {
      const fail = fixture(status);
      const ok = fixture(200);
      globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(ok) as any;

      const res = await run(fetchWithRetry('https://example.com'));

      expect(res).toBe(ok);
      expect(fail.cancel).toHaveBeenCalledTimes(1);
      expect(ok.cancel).not.toHaveBeenCalled();
    },
  );

  it('the body is cancelled before the backoff sleep begins', async () => {
    const fail = fixture(503);
    const ok = fixture(200);
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(ok) as any;

    const p = fetchWithRetry('https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    // Still inside the 1 s backoff: the retried body is already released.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fail.cancel).toHaveBeenCalledTimes(1);
    await run(p);
  });

  it('exhausted retries: every retried body is cancelled, the returned last one keeps its body', async () => {
    const a = fixture(429);
    const b = fixture(429);
    const last = fixture(429, 'raw last body');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(last) as any;

    const res = await run(fetchWithRetry('https://example.com', undefined, { maxRetries: 2 }));

    expect(res).toBe(last);
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(last.cancel).not.toHaveBeenCalled();
    await expect(res.text()).resolves.toBe('raw last body');
  });

  it('a non-retryable error response keeps its body', async () => {
    const bad = fixture(400, 'bad request');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(bad) as any;
    const res = await run(fetchWithRetry('https://example.com'));
    expect(bad.cancel).not.toHaveBeenCalled();
    await expect(res.text()).resolves.toBe('bad request');
  });

  it('aborted mid-retry: the returned response keeps its body', async () => {
    const ctrl = new AbortController();
    const fail = fixture(503, 'unavailable');
    globalThis.fetch = vi.fn(async () => {
      ctrl.abort();
      return fail;
    }) as any;
    const res = await run(fetchWithRetry('https://example.com', { signal: ctrl.signal }));
    expect(res).toBe(fail);
    expect(fail.cancel).not.toHaveBeenCalled();
  });

  it('is null-safe: bodyless fixtures and a body without cancel still retry', async () => {
    const bare = { ok: false, status: 503, headers: new Headers() };
    const noCancel = { ok: false, status: 503, headers: new Headers(), body: {} };
    const ok = fixture(200);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(bare)
      .mockResolvedValueOnce(noCancel)
      .mockResolvedValueOnce(ok) as any;
    const res = await run(fetchWithRetry('https://example.com'));
    expect(res).toBe(ok);
  });

  it('a rejecting cancel does not fail the call or surface an unhandled rejection', async () => {
    // A plain function, not vi.fn: a spy observes its returned promise and so
    // would mark the rejection handled on the transport's behalf.
    let cancelCalls = 0;
    const fail = {
      ...fixture(503),
      body: {
        cancel: () => {
          cancelCalls++;
          return Promise.reject(new TypeError('locked'));
        },
      },
    };
    const ok = fixture(200);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(ok) as any;
      const res = await run(fetchWithRetry('https://example.com'));
      expect(res).toBe(ok);
      expect(cancelCalls).toBe(1);
      // Give Node a macrotask to report an unhandled rejection, if any.
      await new Promise<void>((r) => realSetImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('under a governor, a real Response stream is cancelled on retry', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fail = new Response(stream, { status: 503 });
    const ok = new Response('{}', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(ok) as any;
    const res = await run(
      fetchWithRetry('https://example.com', undefined, {
        governor: new RateLimiter({ maxConcurrent: 1 }),
      }),
    );
    expect(res).toBe(ok);
    expect(cancelled).toBe(true);
  });

  it('through a real adapter, the exhausted 503 surfaces its raw body on ProviderError', async () => {
    const bodies = ['first', 'second', 'raw final 503 body'];
    const responses = bodies.map((b) => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(b));
          c.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return { res: new Response(stream, { status: 503 }), cancelled: () => cancelled };
    });
    let i = 0;
    globalThis.fetch = vi.fn(async () => responses[i++]!.res) as any;
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const p = provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });
    const settled = p.then(
      () => undefined,
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(503);
    expect((err as ProviderError).body).toBe('raw final 503 body');
    expect(responses[0]!.res.bodyUsed || responses[0]!.cancelled()).toBe(true);
    expect(responses[1]!.res.bodyUsed || responses[1]!.cancelled()).toBe(true);
  });
});
