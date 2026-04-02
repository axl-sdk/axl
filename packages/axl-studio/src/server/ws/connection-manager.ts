/**
 * Minimal interface for a connection that can receive broadcast messages.
 * Satisfied by WSContext (Hono), ws.WebSocket (Node.js), and the middleware's
 * adapted socket. Internal to ConnectionManager — not part of the public API.
 */
export interface BroadcastTarget {
  send(data: string): void;
  close?(): void;
}

/**
 * Short-lived event buffer for execution streams.
 * Solves the race where a fast provider (e.g., MockProvider) completes
 * before the client's WS subscription is established. Events are buffered
 * per-channel and replayed to late subscribers.
 */
interface ChannelBuffer {
  events: string[]; // Pre-serialized JSON messages
  complete: boolean; // True after done/error event
  timer?: ReturnType<typeof setTimeout>;
}

/** Channels eligible for replay buffering (execution streams). */
function isBufferedChannel(channel: string): boolean {
  return channel.startsWith('execution:');
}

const BUFFER_TTL_MS = 30_000; // Clean up buffers 30s after stream completes
const MAX_BUFFER_EVENTS = 500; // Cap replay buffer size

/**
 * Manages WebSocket connections and channel subscriptions.
 * Supports channel multiplexing: clients subscribe/unsubscribe to channels
 * and receive events only for channels they're subscribed to.
 *
 * Execution channels (`execution:*`) are replay-buffered: events are stored
 * so that late subscribers receive the full event history. Buffers are cleaned
 * up shortly after the stream completes.
 */
export class ConnectionManager {
  /** channel -> set of WS connections */
  private channels = new Map<string, Set<BroadcastTarget>>();
  /** ws -> set of subscribed channels (for cleanup) */
  private connections = new Map<BroadcastTarget, Set<string>>();
  /** channel -> replay buffer for execution streams */
  private buffers = new Map<string, ChannelBuffer>();
  private maxConnections = 100;

  /** Register a new WS connection. */
  add(ws: BroadcastTarget): void {
    if (this.connections.size >= this.maxConnections) {
      ws.close?.();
      return;
    }
    this.connections.set(ws, new Set());
  }

  /** Remove a WS connection and all its subscriptions. */
  remove(ws: BroadcastTarget): void {
    const channels = this.connections.get(ws);
    if (channels) {
      for (const ch of channels) {
        this.channels.get(ch)?.delete(ws);
        if (this.channels.get(ch)?.size === 0) {
          this.channels.delete(ch);
        }
      }
    }
    this.connections.delete(ws);
  }

  /** Subscribe a connection to a channel. Replays buffered events for execution channels. */
  subscribe(ws: BroadcastTarget, channel: string): void {
    if (!this.connections.has(ws)) return;
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(ws);
    this.connections.get(ws)!.add(channel);

    // Replay buffered events for late subscribers
    const buffer = this.buffers.get(channel);
    if (buffer) {
      for (const msg of buffer.events) {
        try {
          ws.send(msg);
        } catch {
          this.remove(ws);
          return;
        }
      }
    }
  }

  /** Unsubscribe a connection from a channel. */
  unsubscribe(ws: BroadcastTarget, channel: string): void {
    this.channels.get(channel)?.delete(ws);
    if (this.channels.get(channel)?.size === 0) {
      this.channels.delete(channel);
    }
    this.connections.get(ws)?.delete(channel);
  }

  /** Broadcast data to all subscribers of a channel. Buffers events for execution channels. */
  broadcast(channel: string, data: unknown): void {
    const msg = JSON.stringify({ type: 'event', channel, data });

    // Buffer events for execution channels so late subscribers can replay
    if (isBufferedChannel(channel)) {
      let buffer = this.buffers.get(channel);
      if (!buffer) {
        buffer = { events: [], complete: false };
        this.buffers.set(channel, buffer);
      }
      // Always buffer terminal events; skip non-terminal if at capacity
      const event = data as { type?: string };
      const isTerminal = event.type === 'done' || event.type === 'error';
      if (buffer.events.length < MAX_BUFFER_EVENTS || isTerminal) {
        buffer.events.push(msg);
      }

      // Schedule buffer cleanup after terminal events
      if (isTerminal) {
        buffer.complete = true;
        if (buffer.timer) clearTimeout(buffer.timer);
        buffer.timer = setTimeout(() => {
          this.buffers.delete(channel);
        }, BUFFER_TTL_MS);
      }
    }

    // Send to current subscribers
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) return;

    for (const ws of [...subs]) {
      try {
        ws.send(msg);
      } catch {
        this.remove(ws);
      }
    }
  }

  /** Broadcast to channel and all wildcard subscribers (e.g., trace:* matches trace:abc). */
  broadcastWithWildcard(channel: string, data: unknown): void {
    this.broadcast(channel, data);

    // Check for wildcard subscribers: "prefix:*" matches "prefix:anything"
    // Send with the actual channel name so wildcard subscribers know the source.
    const colonIdx = channel.indexOf(':');
    if (colonIdx > 0) {
      const wildcardChannel = channel.substring(0, colonIdx) + ':*';
      const subs = this.channels.get(wildcardChannel);
      if (!subs || subs.size === 0) return;

      const msg = JSON.stringify({ type: 'event', channel, data });
      for (const ws of [...subs]) {
        try {
          ws.send(msg);
        } catch {
          this.remove(ws);
        }
      }
    }
  }

  /** Close all connections, clear all state and buffers. Used during shutdown. */
  closeAll(): void {
    for (const ws of this.connections.keys()) {
      ws.close?.();
    }
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.connections.clear();
    this.channels.clear();
    this.buffers.clear();
  }

  /** Get the number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Check if any connections are subscribed to a channel. */
  hasSubscribers(channel: string): boolean {
    return (this.channels.get(channel)?.size ?? 0) > 0;
  }
}
