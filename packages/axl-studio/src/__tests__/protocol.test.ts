import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import type { BroadcastTarget } from '../server/ws/connection-manager.js';
import { handleWsMessage } from '../server/ws/protocol.js';

function createMockSocket(): { socket: BroadcastTarget; messages: string[] } {
  const messages: string[] = [];
  return {
    socket: {
      send: (msg: string) => messages.push(msg),
      close: () => {},
    },
    messages,
  };
}

describe('handleWsMessage', () => {
  let connMgr: ConnectionManager;

  beforeEach(() => {
    connMgr = new ConnectionManager();
  });

  it('subscribe returns subscribed and adds subscription', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: 'trace:abc' }),
      socket,
      connMgr,
    );
    expect(reply).not.toBeNull();
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('subscribed');
    expect(parsed.channel).toBe('trace:abc');
    expect(connMgr.hasSubscribers('trace:abc')).toBe(true);
  });

  it('unsubscribe returns unsubscribed and removes subscription', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);
    connMgr.subscribe(socket, 'trace:abc');

    const reply = handleWsMessage(
      JSON.stringify({ type: 'unsubscribe', channel: 'trace:abc' }),
      socket,
      connMgr,
    );
    expect(reply).not.toBeNull();
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('unsubscribed');
    expect(parsed.channel).toBe('trace:abc');
    expect(connMgr.hasSubscribers('trace:abc')).toBe(false);
  });

  it('ping returns pong', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(JSON.stringify({ type: 'ping' }), socket, connMgr);
    expect(JSON.parse(reply!).type).toBe('pong');
  });

  it('invalid JSON returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage('not json{{{', socket, connMgr);
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Invalid JSON');
  });

  it('unknown message type returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(JSON.stringify({ type: 'foobar' }), socket, connMgr);
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Unknown message type');
  });

  it('rejects oversized messages (> 64KB)', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const bigMessage = 'x'.repeat(65537);
    const reply = handleWsMessage(bigMessage, socket, connMgr);
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Message too large');
  });

  it('subscribe with missing channel returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(JSON.stringify({ type: 'subscribe' }), socket, connMgr);
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Missing or invalid channel');
  });

  it('subscribe with non-string channel returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: 42 }),
      socket,
      connMgr,
    );
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Missing or invalid channel');
  });

  it('subscribe with invalid channel prefix returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const reply = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: 'invalid:foo' }),
      socket,
      connMgr,
    );
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toContain('Invalid channel');
  });

  it('subscribe with oversized channel name returns error', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    const longChannel = 'trace:' + 'a'.repeat(260);
    const reply = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: longChannel }),
      socket,
      connMgr,
    );
    const parsed = JSON.parse(reply!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toContain('256');
  });

  it('rejects channels that start with valid names but are not exact matches', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    // 'costsomething' is not valid — 'costs' requires exact match
    const reply1 = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: 'costsomething' }),
      socket,
      connMgr,
    );
    expect(JSON.parse(reply1!).type).toBe('error');

    // 'decisionsbanana' is not valid — 'decisions' requires exact match
    const reply2 = handleWsMessage(
      JSON.stringify({ type: 'subscribe', channel: 'decisionsbanana' }),
      socket,
      connMgr,
    );
    expect(JSON.parse(reply2!).type).toBe('error');
  });

  it('allows valid channel prefixes: execution:, trace:, eval:, costs, decisions', () => {
    const { socket } = createMockSocket();
    connMgr.add(socket);

    for (const channel of ['execution:123', 'trace:abc', 'eval:run-1', 'costs', 'decisions']) {
      const reply = handleWsMessage(
        JSON.stringify({ type: 'subscribe', channel }),
        socket,
        connMgr,
      );
      const parsed = JSON.parse(reply!);
      expect(parsed.type).toBe('subscribed');
    }
  });
});
