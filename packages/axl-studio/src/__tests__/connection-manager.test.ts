import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../server/ws/connection-manager.js';

/** Minimal WSContext mock for testing. */
function createMockWs() {
  const messages: string[] = [];
  return {
    ws: {
      send: (msg: string) => {
        messages.push(msg);
      },
    } as unknown as Parameters<ConnectionManager['add']>[0],
    messages,
  };
}

describe('ConnectionManager', () => {
  let connMgr: ConnectionManager;

  beforeEach(() => {
    connMgr = new ConnectionManager();
  });

  it('subscribe + broadcast delivers to subscribers', () => {
    const { ws, messages } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'test-channel');
    connMgr.broadcast('test-channel', { hello: 'world' });

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe('event');
    expect(parsed.channel).toBe('test-channel');
    expect(parsed.data).toEqual({ hello: 'world' });
  });

  it('unsubscribe removes subscriber', () => {
    const { ws, messages } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'channel-a');
    connMgr.unsubscribe(ws, 'channel-a');
    connMgr.broadcast('channel-a', { test: true });

    expect(messages.length).toBe(0);
  });

  it('broadcastWithWildcard sends to both specific and wildcard channels', () => {
    const { ws: ws1, messages: msgs1 } = createMockWs();
    const { ws: ws2, messages: msgs2 } = createMockWs();

    connMgr.add(ws1);
    connMgr.add(ws2);

    // ws1 subscribes to specific channel
    connMgr.subscribe(ws1, 'trace:abc123');
    // ws2 subscribes to wildcard
    connMgr.subscribe(ws2, 'trace:*');

    connMgr.broadcastWithWildcard('trace:abc123', { event: 'data' });

    // Both should receive the message
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);

    // ws1 gets the specific channel
    const parsed1 = JSON.parse(msgs1[0]);
    expect(parsed1.channel).toBe('trace:abc123');

    // ws2 gets the actual channel (not the wildcard pattern) so it knows the source
    const parsed2 = JSON.parse(msgs2[0]);
    expect(parsed2.channel).toBe('trace:abc123');
  });

  it('connectionCount tracks active connections', () => {
    expect(connMgr.connectionCount).toBe(0);

    const { ws: ws1 } = createMockWs();
    const { ws: ws2 } = createMockWs();
    connMgr.add(ws1);
    expect(connMgr.connectionCount).toBe(1);
    connMgr.add(ws2);
    expect(connMgr.connectionCount).toBe(2);

    connMgr.remove(ws1);
    expect(connMgr.connectionCount).toBe(1);
    connMgr.remove(ws2);
    expect(connMgr.connectionCount).toBe(0);
  });

  it('hasSubscribers returns correct state', () => {
    const { ws } = createMockWs();
    connMgr.add(ws);

    expect(connMgr.hasSubscribers('channel-x')).toBe(false);
    connMgr.subscribe(ws, 'channel-x');
    expect(connMgr.hasSubscribers('channel-x')).toBe(true);
    connMgr.unsubscribe(ws, 'channel-x');
    expect(connMgr.hasSubscribers('channel-x')).toBe(false);
  });

  it('remove cleans up all subscriptions for a connection', () => {
    const { ws } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'ch-1');
    connMgr.subscribe(ws, 'ch-2');
    connMgr.subscribe(ws, 'ch-3');

    expect(connMgr.hasSubscribers('ch-1')).toBe(true);
    expect(connMgr.hasSubscribers('ch-2')).toBe(true);
    expect(connMgr.hasSubscribers('ch-3')).toBe(true);

    connMgr.remove(ws);

    expect(connMgr.hasSubscribers('ch-1')).toBe(false);
    expect(connMgr.hasSubscribers('ch-2')).toBe(false);
    expect(connMgr.hasSubscribers('ch-3')).toBe(false);
    expect(connMgr.connectionCount).toBe(0);
  });
});
