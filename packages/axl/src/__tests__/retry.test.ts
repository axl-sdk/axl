import { createServer } from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, type FetchTiming } from '../providers/retry.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { expectWindow } from './helpers.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('fetchWithRetry', () => {
  it('returns immediately on success', async () => {
    const mockRes = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(mockRes);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on non-retryable error', async () => {
    const mockRes = { ok: false, status: 400, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(mockRes);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    const fail = { ok: false, status: 429, headers: new Headers() };
    const success = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(success) as any;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(success);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds', async () => {
    const fail = { ok: false, status: 503, headers: new Headers() };
    const success = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(success) as any;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(success);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns error response after exhausting retries', async () => {
    const fail = { ok: false, status: 429, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(fail) as any;

    const res = await fetchWithRetry('https://example.com', undefined, { maxRetries: 2 });
    expect(res).toBe(fail);
    // 1 initial + 2 retries = 3 total
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('respects Retry-After header', async () => {
    const headers = new Headers({ 'retry-after': '2' });
    const fail = { ok: false, status: 429, headers };
    const success = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(success) as any;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(success);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when signal is aborted', async () => {
    const fail = { ok: false, status: 429, headers: new Headers() };
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue(fail) as any;

    // Abort after first response
    const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchFn.mockImplementation(async () => {
      controller.abort();
      return fail;
    });

    const res = await fetchWithRetry('https://example.com', { signal: controller.signal });
    expect(res).toBe(fail);
    // Should not retry after abort
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('passes init options through while forcing manual redirects', async () => {
    const mockRes = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;

    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    };

    await fetchWithRetry('https://example.com', init);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com', {
      ...init,
      redirect: 'manual',
    });
  });

  it('overrides a caller attempt to follow redirects', async () => {
    const mockRes = { ok: false, status: 302, headers: new Headers({ location: 'https://other' }) };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;

    await expect(fetchWithRetry('https://example.com', { redirect: 'follow' })).resolves.toBe(
      mockRes,
    );
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com', { redirect: 'manual' });
  });

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %i redirect to a second endpoint',
    async (status) => {
      vi.useRealTimers();
      let initialRequests = 0;
      let targetRequests = 0;
      const server = createServer((request, response) => {
        if (request.url === '/initial') {
          initialRequests++;
          response.writeHead(status, { Location: '/target' });
          response.end();
          return;
        }
        if (request.url === '/target') targetRequests++;
        response.writeHead(200);
        response.end('target');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP test server');

      try {
        const response = await fetchWithRetry(`http://127.0.0.1:${address.port}/initial`, {
          method: 'POST',
          headers: { Authorization: 'Bearer test' },
          body: 'prompt body',
        });

        expect(response.status).toBe(status);
        expect(initialRequests).toBe(1);
        expect(targetRequests).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

describe('fetchWithRetry + governor', () => {
  it('caps in-flight requests at maxConcurrent across calls', async () => {
    const rl = new RateLimiter({ maxConcurrent: 2 });
    let concurrent = 0;
    let peak = 0;
    globalThis.fetch = vi.fn(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await delay(5);
      concurrent--;
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    await Promise.all(
      Array.from({ length: 8 }, () => fetchWithRetry('https://x', undefined, { governor: rl })),
    );
    expect(peak).toBe(2);
  });

  it('holds one permit across a 429 → retry → success for the whole loop', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    let concurrent = 0;
    let peak = 0;
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await delay(5);
      concurrent--;
      n++;
      // The first caller's first fetch 429s with retry-after:0 (instant retry),
      // so it does TWO fetches before releasing the permit. The second caller
      // must not interleave with that retry → peak stays 1.
      if (n === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }) };
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    await Promise.all([
      fetchWithRetry('https://x', undefined, { governor: rl }),
      fetchWithRetry('https://x', undefined, { governor: rl }),
    ]);
    expect(peak).toBe(1);
    expect(n).toBe(3); // caller A: 429 + ok = 2; caller B: ok = 1
  });

  it('releases the permit on an exhausted network failure (next caller proceeds)', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('network down');
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    // maxRetries:0 ⇒ no retry: the network throw is normalized to a
    // ProviderError{status:0} (the message is preserved verbatim).
    await expect(
      fetchWithRetry('https://x', undefined, { governor: rl, maxRetries: 0 }),
    ).rejects.toThrow('network down');
    // If the permit had leaked, this second call would hang forever under cap 1.
    await expect(fetchWithRetry('https://x', undefined, { governor: rl })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('does not deadlock on a nested (sequential) same-governor call under maxConcurrent:1', async () => {
    // The realistic nesting model: a permit is held only across ONE fetchWithRetry,
    // released before the agent loop runs a tool whose nested ask makes another
    // governed call. So sequential same-governor calls under cap 1 must complete.
    const rl = new RateLimiter({ maxConcurrent: 1 });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
    })) as any;
    const outer = async () => {
      await fetchWithRetry('https://outer', undefined, { governor: rl });
      await fetchWithRetry('https://nested', undefined, { governor: rl });
      return 'done';
    };
    await expect(outer()).resolves.toBe('done');
  });

  it('releases the permit even if governor.observe() throws (future adaptive seam)', async () => {
    // observe() is a v1 no-op, but a future header-driven implementation could
    // throw. It runs inside fetchWithRetry's try, so the finally must still
    // release the permit — otherwise a throwing observe would wedge the governor.
    const rl = new RateLimiter({ maxConcurrent: 1 });
    const observeSpy = vi.spyOn(rl, 'observe').mockImplementation(() => {
      throw new Error('observe boom');
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, headers: new Headers() }) as any;

    await expect(fetchWithRetry('https://x', undefined, { governor: rl })).rejects.toThrow(
      'observe boom',
    );
    // Permit released despite the throw → the next call proceeds (would hang under cap 1 if leaked).
    observeSpy.mockRestore();
    await expect(fetchWithRetry('https://x', undefined, { governor: rl })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('is byte-identical to no-governor when governor is undefined', async () => {
    const mockRes = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;
    const res = await fetchWithRetry('https://x', undefined, {});
    expect(res).toBe(mockRes);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transport timing observer (AC-1, AC-2). The observer is passive: it must
// never change what fetchWithRetry returns or throws, and it must attribute
// self-imposed queue wait separately from provider time.
//
// REAL TIMERS on purpose. Fake timers do not drive an unresolved `fetch`
// promise, so the measured deltas collapse toward zero and every window passes
// vacuously. These are `Date.now()` deltas across real promise scheduling.
//
// Every assertion below is TWO-SIDED. A bare `>=` is satisfied by the exact
// implementation this feature exists to prevent: one that reports total elapsed
// time in every bucket, which is the original inflation reproduced inside the
// new field.
// ---------------------------------------------------------------------------

describe('fetchWithRetry timing observer', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports queuedMs 0 without a governor (T1)', async () => {
    globalThis.fetch = vi.fn(async () => {
      await delay(60);
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    const seen: FetchTiming[] = [];
    await fetchWithRetry('https://x', undefined, {
      timing: { onComplete: (t) => seen.push(t) },
    });

    expect(seen).toHaveLength(1);
    const [t] = seen;
    // Strict zeros. Nothing that happens before the fetch loop — argument prep,
    // an awaited API-key callback — may leak into a bucket.
    expect(t.queuedMs).toBe(0);
    expect(t.attempts).toBe(1);
    expect(t.retryMs).toBe(0);
    expectWindow(t.headersAt - t.dispatchedAt, [40, 160], 'ttfb');
  });

  it('charges a governed call that had to wait behind another (AC-1, T2)', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    // Deliberately unequal: a slow first fetch, a fast second one. That makes
    // the waiter's queue time and its own response time different numbers, so
    // an implementation that confused the two fails a window.
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      await delay(n++ === 0 ? 300 : 40);
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    const seen: FetchTiming[] = [];
    const call = () =>
      fetchWithRetry('https://x', undefined, {
        governor: rl,
        timing: { onComplete: (t) => seen.push(t) },
      });

    await Promise.all([call(), call()]);

    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    // The first call takes the free permit immediately.
    expectWindow(first.queuedMs, [0, 40], 'first queuedMs');
    // The waiter blocks for the first call's ~300ms fetch, and no longer.
    expectWindow(second.queuedMs, [260, 420], 'second queuedMs');
    // Its own response time is the fast fetch. An implementation that measured
    // from acquire-start rather than final dispatch would land near 340 here.
    expectWindow(second.headersAt - second.dispatchedAt, [20, 140], 'second ttfb');
    expect(second.attempts).toBe(1);
    expect(second.retryMs).toBe(0);
  });

  it('counts minIntervalMs spacing as queue time (T3)', async () => {
    // R-T2 defines queuedMs as the SDK's own pacing, which includes interval
    // spacing — not just the concurrency semaphore. An implementation that
    // instruments only the semaphore reports 0 for the second call.
    const rl = new RateLimiter({ minIntervalMs: 200 });
    globalThis.fetch = vi.fn(async () => {
      await delay(10);
      return { ok: true, status: 200, headers: new Headers() };
    }) as any;

    const seen: FetchTiming[] = [];
    const call = () =>
      fetchWithRetry('https://x', undefined, {
        governor: rl,
        timing: { onComplete: (t) => seen.push(t) },
      });

    await call();
    await call();

    expect(seen).toHaveLength(2);
    expectWindow(seen[0].queuedMs, [0, 40], 'first queuedMs');
    expectWindow(seen[1].queuedMs, [150, 300], 'spaced queuedMs');
  });

  it('separates retry time from the final attempt, and notifies each dispatch (AC-2, T4-T6)', async () => {
    // retry-after: 0.05 ⇒ a 50ms base backoff, jittered to 37.5–62.5ms, twice.
    // The two failed attempts are fast (10ms) and the successful one is slow
    // (200ms), so retryMs and the final wire occupy disjoint ranges.
    const retryAfter = new Headers({ 'retry-after': '0.05' });
    const fetchStarts: number[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchStarts.push(Date.now());
      const attempt = ++n;
      await delay(attempt < 3 ? 10 : 200);
      return attempt < 3
        ? { ok: false, status: 429, headers: retryAfter }
        : { ok: true, status: 200, headers: new Headers() };
    }) as any;

    const dispatches: Array<[number, number]> = [];
    let timing: FetchTiming | undefined;
    const res = await fetchWithRetry('https://x', undefined, {
      timing: {
        onDispatch: (attempt, at) => dispatches.push([attempt, at]),
        onComplete: (t) => (timing = t),
      },
    });

    expect(res.ok).toBe(true);
    const t = timing!;
    // `attempts` is a total, not a retry count: 2 would mean the final attempt
    // was not counted.
    expect(t.attempts).toBe(3);
    // Two 10ms attempts plus two jittered ~50ms backoffs ⇒ roughly 95..145ms.
    // The strict upper bound is what proves the final 200ms wire is NOT inside
    // it — a first-dispatch-to-completion implementation would land near 300.
    expectWindow(t.retryMs, [80, 200], 'retryMs');
    // ttfb anchors on the FINAL attempt (~200ms), not the first (~10ms).
    expectWindow(t.headersAt - t.dispatchedAt, [160, 320], 'final ttfb');
    // `dispatchedAt` is the third attempt's fetch start.
    expect(t.dispatchedAt).toBe(dispatches[2][1]);
    expectWindow(fetchStarts[2] - t.dispatchedAt, [0, 20], 'dispatchedAt vs. third fetch');

    // Dispatch notification: 1-indexed, once per attempt, monotonic. No v1
    // consumer ships for this — it is the arming point Spec 23's stallTimeout
    // will use — so treat it as a forward-compatibility contract, not as
    // evidence that anything in this release reads it.
    expect(dispatches.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(dispatches[1][1]).toBeGreaterThan(dispatches[0][1]);
    expect(dispatches[2][1]).toBeGreaterThan(dispatches[1][1]);
  });

  it('fires onComplete on the aborted-mid-retry return path', async () => {
    // A signal aborted while the request is in flight makes the loop stop
    // retrying and RETURN the 429 rather than throw. That is still a return
    // path, so the observer fires, and the figures describe the one attempt
    // that happened. A regression that moved reportComplete above the aborted
    // check, or dropped it there, is otherwise invisible.
    const controller = new AbortController();
    const failure = { ok: false, status: 429, headers: new Headers({ 'retry-after': '0.3' }) };
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      return failure;
    }) as any;

    const onComplete = vi.fn();
    const res = await fetchWithRetry(
      'https://x',
      { signal: controller.signal },
      { timing: { onComplete } },
    );

    // The 429 is returned, not thrown — the adapter turns it into a ProviderError.
    expect(res).toBe(failure);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const t = onComplete.mock.calls[0][0] as FetchTiming;
    // One attempt was made, so there is no retry span to report.
    expect(t.attempts).toBe(1);
    expect(t.retryMs).toBe(0);
    // onComplete means "the transport returned a Response", NOT "the call
    // succeeded" — this is the case that makes the distinction concrete.
    expect(res.ok).toBe(false);
  });

  it('does not fire onComplete when the call throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as any;

    const onComplete = vi.fn();
    await expect(
      fetchWithRetry('https://x', undefined, { maxRetries: 0, timing: { onComplete } }),
    ).rejects.toThrow('network down');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not fire either callback when acquire rejects, and the abort propagates verbatim (T7)', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    const controller = new AbortController();
    const reason = new Error('caller aborted');
    reason.name = 'AbortError';
    controller.abort(reason);

    globalThis.fetch = vi.fn() as any;
    const onDispatch = vi.fn();
    const onComplete = vi.fn();

    await expect(
      fetchWithRetry(
        'https://x',
        { signal: controller.signal },
        {
          governor: rl,
          timing: { onDispatch, onComplete },
        },
      ),
    ).rejects.toThrow();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports timing for a non-retryable error response (data is in scope at the throw site)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, headers: new Headers() }) as any;

    let timing: FetchTiming | undefined;
    await fetchWithRetry('https://x', undefined, { timing: { onComplete: (t) => (timing = t) } });
    expect(timing?.attempts).toBe(1);
    expect(timing?.retryMs).toBe(0);
  });
});
