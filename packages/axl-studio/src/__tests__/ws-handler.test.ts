import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import { createWsHandlers } from '../server/ws/handler.js';

/** Minimal WSContext mock that captures sent messages. */
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

describe('WebSocket Handler', () => {
  let connMgr: ConnectionManager;
  let handlers: ReturnType<typeof createWsHandlers>;

  beforeEach(() => {
    connMgr = new ConnectionManager();
    handlers = createWsHandlers(connMgr);
  });

  it('onOpen adds connection to ConnectionManager', () => {
    const { ws } = createMockWs();
    expect(connMgr.connectionCount).toBe(0);
    handlers.onOpen({} as Event, ws);
    expect(connMgr.connectionCount).toBe(1);
  });

  it('onClose removes connection from ConnectionManager', () => {
    const { ws } = createMockWs();
    handlers.onOpen({} as Event, ws);
    expect(connMgr.connectionCount).toBe(1);
    handlers.onClose({} as CloseEvent, ws);
    expect(connMgr.connectionCount).toBe(0);
  });

  it('onError removes connection from ConnectionManager', () => {
    const { ws } = createMockWs();
    handlers.onOpen({} as Event, ws);
    expect(connMgr.connectionCount).toBe(1);
    handlers.onError({} as Event, ws);
    expect(connMgr.connectionCount).toBe(0);
  });

  it('subscribe message adds subscription and replies with subscribed', () => {
    const { ws, messages } = createMockWs();
    handlers.onOpen({} as Event, ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: 'subscribe', channel: 'trace:abc' }) } as MessageEvent,
      ws,
    );

    expect(connMgr.hasSubscribers('trace:abc')).toBe(true);
    expect(messages.length).toBe(1);
    const reply = JSON.parse(messages[0]);
    expect(reply.type).toBe('subscribed');
    expect(reply.channel).toBe('trace:abc');
  });

  it('unsubscribe message removes subscription and replies with unsubscribed', () => {
    const { ws, messages } = createMockWs();
    handlers.onOpen({} as Event, ws);
    connMgr.subscribe(ws, 'trace:abc');

    handlers.onMessage(
      { data: JSON.stringify({ type: 'unsubscribe', channel: 'trace:abc' }) } as MessageEvent,
      ws,
    );

    expect(connMgr.hasSubscribers('trace:abc')).toBe(false);
    expect(messages.length).toBe(1);
    const reply = JSON.parse(messages[0]);
    expect(reply.type).toBe('unsubscribed');
    expect(reply.channel).toBe('trace:abc');
  });

  it('ping message replies with pong', () => {
    const { ws, messages } = createMockWs();
    handlers.onOpen({} as Event, ws);

    handlers.onMessage({ data: JSON.stringify({ type: 'ping' }) } as MessageEvent, ws);

    expect(messages.length).toBe(1);
    const reply = JSON.parse(messages[0]);
    expect(reply.type).toBe('pong');
  });

  it('unknown message type replies with error', () => {
    const { ws, messages } = createMockWs();
    handlers.onOpen({} as Event, ws);

    handlers.onMessage({ data: JSON.stringify({ type: 'unknown-type' }) } as MessageEvent, ws);

    expect(messages.length).toBe(1);
    const reply = JSON.parse(messages[0]);
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('Unknown');
  });

  it('invalid JSON replies with error', () => {
    const { ws, messages } = createMockWs();
    handlers.onOpen({} as Event, ws);

    handlers.onMessage({ data: 'not-json{{{' } as MessageEvent, ws);

    expect(messages.length).toBe(1);
    const reply = JSON.parse(messages[0]);
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('Invalid JSON');
  });
});
