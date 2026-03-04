import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../providers/retry.js';

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

    const res = await fetchWithRetry('https://example.com', undefined, 2);
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
