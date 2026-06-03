import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../providers/retry.js';
import { RateLimiter } from '../providers/rate-limiter.js';

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

  it('passes init options through to fetch', async () => {
    const mockRes = { ok: true, status: 200, headers: new Headers() };
    globalThis.fetch = vi.fn().mockResolvedValue(mockRes) as any;

    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    };

    await fetchWithRetry('https://example.com', init);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com', init);
  });
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
