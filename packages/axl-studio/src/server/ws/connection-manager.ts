import type { WSContext } from 'hono/ws';

/**
 * Manages WebSocket connections and channel subscriptions.
 * Supports channel multiplexing: clients subscribe/unsubscribe to channels
 * and receive events only for channels they're subscribed to.
 */
export class ConnectionManager {
  /** channel -> set of WS connections */
  private channels = new Map<string, Set<WSContext>>();
  /** ws -> set of subscribed channels (for cleanup) */
  private connections = new Map<WSContext, Set<string>>();

  /** Register a new WS connection. */
  add(ws: WSContext): void {
    this.connections.set(ws, new Set());
  }

  /** Remove a WS connection and all its subscriptions. */
  remove(ws: WSContext): void {
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

  /** Subscribe a connection to a channel. */
  subscribe(ws: WSContext, channel: string): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(ws);
    this.connections.get(ws)?.add(channel);
  }

  /** Unsubscribe a connection from a channel. */
  unsubscribe(ws: WSContext, channel: string): void {
    this.channels.get(channel)?.delete(ws);
    if (this.channels.get(channel)?.size === 0) {
      this.channels.delete(channel);
    }
    this.connections.get(ws)?.delete(channel);
  }

  /** Broadcast data to all subscribers of a channel. */
  broadcast(channel: string, data: unknown): void {
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) return;

    const msg = JSON.stringify({ type: 'event', channel, data });
    for (const ws of [...subs]) {
      try {
        ws.send(msg);
      } catch {
        // Connection closed — clean up
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

  /** Get the number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Check if any connections are subscribed to a channel. */
  hasSubscribers(channel: string): boolean {
    return (this.channels.get(channel)?.size ?? 0) > 0;
  }
}
