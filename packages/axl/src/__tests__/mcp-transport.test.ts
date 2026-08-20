import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxlError } from '../errors.js';
import { HttpMcpClient } from '../mcp/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HTTP MCP transport security', () => {
  it('rejects remote HTTP before network I/O', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(
      () => new HttpMcpClient({ name: 'remote', uri: 'http://mcp.internal/rpc' }),
    ).toThrowError(expect.objectContaining<Partial<AxlError>>({ code: 'UNSAFE_TRANSPORT' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows loopback HTTP without an override', () => {
    expect(
      () => new HttpMcpClient({ name: 'local', uri: 'http://127.0.0.1:3000/rpc' }),
    ).not.toThrow();
  });

  it('allows an explicit remote HTTP opt-in and forces manual redirects', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(rpcResult({ protocolVersion: '2024-11-05' }))
      .mockResolvedValueOnce(rpcResult({ tools: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new HttpMcpClient({
      name: 'trusted-dev',
      uri: 'http://mcp.internal/rpc',
      dangerouslyAllowInsecureHttp: true,
    });

    await client.connect();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    }
  });

  it('surfaces a redirect without following or retrying it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { Location: 'https://other.example/rpc' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new HttpMcpClient({ name: 'secure', uri: 'https://mcp.example/rpc' });

    await expect(client.connect()).rejects.toThrow('MCP HTTP error (307)');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
