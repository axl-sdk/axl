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
interface BufferedEvent {
  /** Pre-serialized JSON message (ready to `ws.send`). */
  msg: string;
  /** Original event data for filter evaluation on replay. */
  data: unknown;
}

interface ChannelBuffer {
  events: BufferedEvent[];
  complete: boolean; // True after done/error event
  timer?: ReturnType<typeof setTimeout>;
}

const BUFFER_TTL_MS = 30_000; // Clean up buffers 30s after stream completes
const MAX_BUFFER_EVENTS = 1000; // Cap replay buffer size (raised from 500 in
// spec/16 §5.2 to absorb nested-ask volume —
// ~10 nested asks × ~20 structural events
// each, with headroom).

/**
 * Stream-only event types excluded from the replay buffer entirely.
 * Late subscribers to an in-flight stream don't need per-token chatter
 * or per-delta progressive-render snapshots — they reconstruct the same
 * info from the final `agent_call_end` (token aggregates) and `done`
 * (final result). Both types are stream-only ergonomics, not
 * correctness-critical for replay. Spec/16 §5.2.
 */
const UNBUFFERED_EVENT_TYPES = new Set(['token', 'partial_object']);

/** WS frame size soft cap. Used for both the inbound message reject in
 *  `protocol.ts` and the outbound broadcast truncation below — keeping them
 *  in one place so they never drift. Events that serialize larger than this
 *  on the outbound path are replaced with a truncated placeholder so
 *  consumers still receive a signal instead of having the browser's WS
 *  client silently drop or close the connection. */
export const MAX_WS_FRAME_BYTES = 65536;

/** Channels eligible for replay buffering (execution streams). */
function isBufferedChannel(channel: string): boolean {
  return channel.startsWith('execution:') || channel.startsWith('eval:');
}

/**
 * Guard against outbound frames that exceed the WS size budget. Verbose-mode
 * `agent_call` events with a full `messages[]` snapshot can balloon past 64KB
 * on long conversations; browsers/ws libraries behave inconsistently when this
 * happens (silent drop, connection close, errors). Instead of hoping the
 * underlying stack handles it, we serialize once, check size, and fall back to
 * a truncated placeholder event if the payload is too large.
 *
 * The replacement preserves `channel`, `data.type`, `data.step`, `data.agent`,
 * and `data.tool` so the UI still sees the event shape — it just sees an
 * explicit truncation marker instead of silently losing data.
 */
function truncateIfOversized(msg: string, channel: string, data: unknown): string {
  // WS frame budgets are measured in bytes. `string.length` counts UTF-16
  // code units; a payload with emoji / CJK / other multi-byte UTF-8 chars
  // can pass `msg.length <= 65536` yet serialize to >128KB when the
  // browser encodes the frame. Measure bytes directly to avoid
  // reintroducing the silent-drop / disconnect behavior this function
  // exists to prevent.
  const msgBytes = Buffer.byteLength(msg, 'utf8');
  if (msgBytes <= MAX_WS_FRAME_BYTES) return msg;
  const event = (data ?? {}) as {
    type?: string;
    step?: number;
    agent?: string;
    tool?: string;
    executionId?: string;
  };
  const truncated = {
    type: 'event',
    channel,
    data: {
      ...event,
      data: {
        __truncated: true,
        originalBytes: msgBytes,
        maxBytes: MAX_WS_FRAME_BYTES,
        hint: 'Event exceeded WS frame budget (likely a verbose agent_call with a large messages[] snapshot). Fetch via REST if you need the full payload.',
      },
    },
  };
  return JSON.stringify(truncated);
}

/**
 * Per-event, per-connection filter used by multi-tenant integrators to scope
 * the trace firehose. Return `true` to deliver the event to this connection,
 * `false` to skip it.
 *
 * `event` is the parsed payload (the same shape that was passed to `broadcast`);
 * `metadata` is whatever the middleware attached via `setMetadata(ws, ...)`
 * after a successful `verifyUpgrade` — typically `{ userId, tenantId }` or
 * similar, sourced from the upgrade request's auth token.
 */
export type BroadcastFilter = (event: unknown, metadata: unknown) => boolean;

/**
 * Manages WebSocket connections and channel subscriptions.
 * Supports channel multiplexing: clients subscribe/unsubscribe to channels
 * and receive events only for channels they're subscribed to.
 *
 * Execution channels (`execution:*`) are replay-buffered: events are stored
 * so that late subscribers receive the full event history. Buffers are cleaned
 * up shortly after the stream completes.
 *
 * Multi-tenant deployments can attach per-connection metadata via
 * `setMetadata(ws, data)` and register a `BroadcastFilter` to scope the
 * trace firehose to the authenticated user/tenant.
 */
export class ConnectionManager {
  /** channel -> set of WS connections */
  private channels = new Map<string, Set<BroadcastTarget>>();
  /** ws -> subscribed channels + optional integrator-supplied metadata */
  private connections = new Map<BroadcastTarget, { channels: Set<string>; metadata?: unknown }>();
  /** channel -> replay buffer for execution streams */
  private buffers = new Map<string, ChannelBuffer>();
  private maxConnections = 100;
  private filter?: BroadcastFilter;

  /**
   * Register a broadcast filter. Called once at middleware construction.
   * The filter runs on every outbound event and can drop or deliver based
   * on the destination connection's metadata.
   */
  setFilter(filter: BroadcastFilter | undefined): void {
    this.filter = filter;
  }

  /** Attach integrator-supplied metadata to an already-added connection. */
  setMetadata(ws: BroadcastTarget, metadata: unknown): void {
    const entry = this.connections.get(ws);
    if (entry) entry.metadata = metadata;
  }

  /** Register a new WS connection. */
  add(ws: BroadcastTarget): void {
    if (this.connections.size >= this.maxConnections) {
      ws.close?.();
      return;
    }
    this.connections.set(ws, { channels: new Set() });
  }

  /** Remove a WS connection and all its subscriptions. */
  remove(ws: BroadcastTarget): void {
    const entry = this.connections.get(ws);
    if (entry) {
      for (const ch of entry.channels) {
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
    this.connections.get(ws)!.channels.add(channel);

    // Replay buffered events for late subscribers. Filter is re-applied on
    // replay so a tenant-B subscriber joining an execution channel doesn't
    // get tenant-A events that were buffered before it connected.
    const buffer = this.buffers.get(channel);
    if (buffer) {
      const metadata = this.connections.get(ws)?.metadata;
      for (const event of buffer.events) {
        if (this.filter) {
          try {
            if (!this.filter(event.data, metadata)) continue;
          } catch {
            continue;
          }
        }
        try {
          ws.send(event.msg);
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
    this.connections.get(ws)?.channels.delete(channel);
  }

  /** Broadcast data to all subscribers of a channel. Buffers events for execution channels. */
  broadcast(channel: string, data: unknown): void {
    const msg = truncateIfOversized(
      JSON.stringify({ type: 'event', channel, data }),
      channel,
      data,
    );

    // Buffer events for execution channels so late subscribers can replay
    if (isBufferedChannel(channel)) {
      let buffer = this.buffers.get(channel);
      if (!buffer) {
        buffer = { events: [], complete: false };
        this.buffers.set(channel, buffer);
      }
      // Always buffer terminal events; skip non-terminal if at capacity;
      // never buffer high-volume types (token, partial_object) per
      // spec/16 §5.2 — late subscribers reconstruct the same info from
      // structural events.
      const event = data as { type?: string };
      const isTerminal = event.type === 'done' || event.type === 'error';
      const isUnbuffered = event.type !== undefined && UNBUFFERED_EVENT_TYPES.has(event.type);
      if (!isUnbuffered && (buffer.events.length < MAX_BUFFER_EVENTS || isTerminal)) {
        buffer.events.push({ msg, data });
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
      // Multi-tenant filter: drop events that don't match this connection's
      // metadata (e.g., wrong tenant). Filter errors are treated as `drop`
      // so a buggy predicate can't accidentally leak events cross-tenant.
      if (this.filter) {
        const metadata = this.connections.get(ws)?.metadata;
        try {
          if (!this.filter(data, metadata)) continue;
        } catch {
          continue;
        }
      }
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

      const msg = truncateIfOversized(
        JSON.stringify({ type: 'event', channel, data }),
        channel,
        data,
      );
      for (const ws of [...subs]) {
        if (this.filter) {
          const metadata = this.connections.get(ws)?.metadata;
          try {
            if (!this.filter(data, metadata)) continue;
          } catch {
            continue;
          }
        }
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
