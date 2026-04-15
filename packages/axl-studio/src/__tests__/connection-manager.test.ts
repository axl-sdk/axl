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

  it('closeAll closes all connections and clears subscriptions', () => {
    const closed: boolean[] = [];
    const mockWsWithClose = () => {
      const messages: string[] = [];
      return {
        ws: {
          send: (msg: string) => messages.push(msg),
          close: () => closed.push(true),
        } as unknown as Parameters<ConnectionManager['add']>[0],
        messages,
      };
    };

    const { ws: ws1 } = mockWsWithClose();
    const { ws: ws2 } = mockWsWithClose();

    connMgr.add(ws1);
    connMgr.add(ws2);
    connMgr.subscribe(ws1, 'trace:abc');
    connMgr.subscribe(ws2, 'costs');

    expect(connMgr.connectionCount).toBe(2);
    expect(connMgr.hasSubscribers('trace:abc')).toBe(true);
    expect(connMgr.hasSubscribers('costs')).toBe(true);

    connMgr.closeAll();

    expect(connMgr.connectionCount).toBe(0);
    expect(connMgr.hasSubscribers('trace:abc')).toBe(false);
    expect(connMgr.hasSubscribers('costs')).toBe(false);
    expect(closed.length).toBe(2);
  });

  describe('per-connection trace filtering (multi-tenant)', () => {
    it('scopes broadcasts to connections whose metadata matches the filter', () => {
      const { ws: tenantA, messages: msgsA } = createMockWs();
      const { ws: tenantB, messages: msgsB } = createMockWs();
      connMgr.add(tenantA);
      connMgr.add(tenantB);
      connMgr.setMetadata(tenantA, { tenantId: 'A' });
      connMgr.setMetadata(tenantB, { tenantId: 'B' });
      connMgr.subscribe(tenantA, 'trace:*');
      connMgr.subscribe(tenantB, 'trace:*');

      // Filter: deliver only when event.tenantId matches the connection's.
      connMgr.setFilter((event, metadata) => {
        const e = event as { tenantId?: string };
        const m = metadata as { tenantId?: string } | undefined;
        return !!e.tenantId && e.tenantId === m?.tenantId;
      });

      connMgr.broadcastWithWildcard('trace:exec-1', { tenantId: 'A', data: 'secret-A' });
      connMgr.broadcastWithWildcard('trace:exec-2', { tenantId: 'B', data: 'secret-B' });

      // Each tenant sees only its own event
      expect(msgsA).toHaveLength(1);
      expect(msgsB).toHaveLength(1);
      const parsedA = JSON.parse(msgsA[0]);
      const parsedB = JSON.parse(msgsB[0]);
      expect(parsedA.data.tenantId).toBe('A');
      expect(parsedB.data.tenantId).toBe('B');
    });

    it('treats filter exceptions as drop (fail-closed)', () => {
      const { ws, messages } = createMockWs();
      connMgr.add(ws);
      connMgr.subscribe(ws, 'trace:abc');

      connMgr.setFilter(() => {
        throw new Error('predicate blew up');
      });
      connMgr.broadcast('trace:abc', { hello: 'world' });

      expect(messages).toHaveLength(0);
    });

    it('re-applies filter on buffered replay when late subscriber joins', () => {
      // Broadcast with no subscribers yet — events go into the replay buffer
      connMgr.broadcast('execution:run-1', { tenantId: 'A', step: 1 });
      connMgr.broadcast('execution:run-1', { tenantId: 'A', step: 2 });

      // Install a filter, then a tenant-B subscriber joins late. They should
      // NOT see tenant A's buffered events.
      connMgr.setFilter((event, metadata) => {
        const e = event as { tenantId?: string };
        const m = metadata as { tenantId?: string } | undefined;
        return e.tenantId === m?.tenantId;
      });
      const { ws: tenantB, messages: msgsB } = createMockWs();
      connMgr.add(tenantB);
      connMgr.setMetadata(tenantB, { tenantId: 'B' });
      connMgr.subscribe(tenantB, 'execution:run-1');

      expect(msgsB).toHaveLength(0);
    });
  });

  it('truncates oversized broadcast payloads to a placeholder event', () => {
    // Build a payload well above the 64KB WS frame budget. Verbose-mode
    // agent_call events with a long conversation history can easily reach
    // this size on real workloads; consumers should receive an explicit
    // truncation marker rather than have the underlying socket silently drop.
    const { ws, messages } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'execution:big');

    const hugeMessages = new Array(200).fill(null).map((_, i) => ({
      role: 'user',
      content: 'x'.repeat(500) + ` (msg ${i})`,
    }));
    connMgr.broadcast('execution:big', {
      type: 'agent_call',
      step: 5,
      agent: 'helper',
      data: { messages: hugeMessages, response: 'y'.repeat(500) },
    });

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe('event');
    expect(parsed.channel).toBe('execution:big');
    // Original shape fields preserved (type, step, agent) so consumers still
    // see the event in the stream
    expect(parsed.data.type).toBe('agent_call');
    expect(parsed.data.step).toBe(5);
    expect(parsed.data.agent).toBe('helper');
    // Data replaced with a truncation marker
    expect(parsed.data.data.__truncated).toBe(true);
    expect(parsed.data.data.originalBytes).toBeGreaterThan(65536);
  });

  it('lets small broadcasts pass through unchanged', () => {
    const { ws, messages } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'trace:small');
    connMgr.broadcast('trace:small', { type: 'log', data: { event: 'ping' } });
    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    // No __truncated marker
    expect(parsed.data.__truncated).toBeUndefined();
    expect(parsed.data.data).toEqual({ event: 'ping' });
  });

  it('maxConnections rejects connections beyond the limit', () => {
    const closed: boolean[] = [];
    // Fill to capacity (maxConnections = 100)
    for (let i = 0; i < 100; i++) {
      const { ws } = createMockWs();
      connMgr.add(ws);
    }
    expect(connMgr.connectionCount).toBe(100);

    // 101st connection should be rejected
    const { ws: rejected } = createMockWs();
    // Override close to track rejection
    (rejected as any).close = () => closed.push(true);
    connMgr.add(rejected);

    expect(connMgr.connectionCount).toBe(100); // Not 101
    expect(closed.length).toBe(1); // close() was called on the rejected socket
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

  it('buffers and replays eval: channel events to late subscribers', () => {
    // Broadcast before any subscriber connects
    connMgr.broadcast('eval:run-1', { type: 'item_done', itemIndex: 0, totalItems: 3 });
    connMgr.broadcast('eval:run-1', { type: 'item_done', itemIndex: 1, totalItems: 3 });
    connMgr.broadcast('eval:run-1', { type: 'done', evalResultId: 'abc-123' });

    // Late subscriber should receive all buffered events
    const { ws, messages } = createMockWs();
    connMgr.add(ws);
    connMgr.subscribe(ws, 'eval:run-1');

    expect(messages).toHaveLength(3);
    const first = JSON.parse(messages[0]);
    expect(first.data.type).toBe('item_done');
    expect(first.data.itemIndex).toBe(0);
    const last = JSON.parse(messages[2]);
    expect(last.data.type).toBe('done');
    expect(last.data.evalResultId).toBe('abc-123');
  });
});
