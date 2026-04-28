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
  /** Sum of `msg.length` over buffered events. Byte-accurate; used to
   *  enforce the per-buffer memory cap below. Maintained incrementally
   *  so we don't have to re-scan on every push. */
  bytes: number;
}

const BUFFER_TTL_MS = 30_000; // Clean up buffers 30s after stream completes

/** Default cap on per-channel buffered events (raised from 500 in
 *  spec/16 §5.2 to absorb nested-ask volume — ~10 nested asks × ~20
 *  structural events each, with headroom). Override via the
 *  `bufferCaps.maxEventsPerBuffer` constructor option on
 *  `ConnectionManager`. */
const DEFAULT_MAX_BUFFER_EVENTS = 1000;

/** Default per-buffer byte budget. 1000 events × 64KB max each would
 *  peak at ~64MB per stream; the real-world distribution is bimodal
 *  (hundreds of small structural events + a few verbose `agent_call_end`
 *  snapshots), so 4MB per buffer is generous. When exceeded, new non-
 *  terminal events are dropped (terminal `done`/`error` always
 *  buffered). Review B-4. Override via
 *  `bufferCaps.maxBytesPerBuffer`. */
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Default cap on the number of concurrently-live replay buffers. Each
 *  buffer is an open execution/eval stream; without a cap, a server
 *  that sees sustained churn (say, 10k short-lived executions / minute)
 *  holds 10k × maxBytesPerBuffer = 40GB of event-log memory across the
 *  TTL window. When we hit the cap, the oldest complete buffer is
 *  evicted immediately; if all live buffers are still incomplete, the
 *  oldest one is dropped anyway (its late subscribers will miss the
 *  replay, which is degraded UX but NOT a crash). Review SEC-H5.
 *  Override via `bufferCaps.maxActiveBuffers`. */
const DEFAULT_MAX_ACTIVE_BUFFERS = 256;

/**
 * Operator-tunable replay-buffer resource limits. Exposed via
 * `createStudioMiddleware({ bufferCaps })` and `createServer({ bufferCaps })`
 * so production deployments can tighten or relax memory pressure
 * without forking the package.
 *
 * All three fields are optional; omitted fields fall back to their
 * documented defaults, so passing `{}` is a no-op.
 */
export interface BufferCaps {
  /** Per-channel buffered event count cap. Default: 1000. */
  maxEventsPerBuffer?: number;
  /** Per-channel buffered byte budget. Default: 4 MiB. */
  maxBytesPerBuffer?: number;
  /** Global concurrently-live buffer cap. Default: 256. */
  maxActiveBuffers?: number;
}

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
  /** Resolved replay-buffer caps. Per-instance so embedders can dial them
   *  without monkey-patching module-level constants. */
  private readonly maxEventsPerBuffer: number;
  private readonly maxBytesPerBuffer: number;
  private readonly maxActiveBuffers: number;

  constructor(bufferCaps?: BufferCaps) {
    // Reject pathological values up-front. `0` would silently drop every
    // non-terminal event (operators following the JSDoc to "tighten memory
    // pressure" might pass 0 thinking it disables buffering); negatives
    // make eviction always fire. Fail-loud beats degraded replay UX.
    const validatePositiveInt = (key: keyof BufferCaps, value: number | undefined): void => {
      if (value === undefined) return;
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
        throw new RangeError(`bufferCaps.${key} must be a positive integer (>= 1); got ${value}`);
      }
    };
    validatePositiveInt('maxEventsPerBuffer', bufferCaps?.maxEventsPerBuffer);
    validatePositiveInt('maxBytesPerBuffer', bufferCaps?.maxBytesPerBuffer);
    validatePositiveInt('maxActiveBuffers', bufferCaps?.maxActiveBuffers);
    this.maxEventsPerBuffer = bufferCaps?.maxEventsPerBuffer ?? DEFAULT_MAX_BUFFER_EVENTS;
    this.maxBytesPerBuffer = bufferCaps?.maxBytesPerBuffer ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxActiveBuffers = bufferCaps?.maxActiveBuffers ?? DEFAULT_MAX_ACTIVE_BUFFERS;
  }

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
        // Enforce the global-buffer cap before allocating. Evict the
        // oldest-inserted buffer (Map preserves insertion order, so
        // `.keys().next().value` is the eldest). Prefer evicting a
        // completed buffer if any exist — its late-subscriber window
        // is already effectively closed. Falls back to evicting the
        // eldest live buffer under sustained pressure.
        if (this.buffers.size >= this.maxActiveBuffers) {
          let victim: string | undefined;
          for (const [ch, buf] of this.buffers) {
            if (buf.complete) {
              victim = ch;
              break;
            }
          }
          if (victim === undefined) {
            victim = this.buffers.keys().next().value as string | undefined;
          }
          if (victim !== undefined) {
            const old = this.buffers.get(victim);
            if (old?.timer) clearTimeout(old.timer);
            this.buffers.delete(victim);
          }
        }
        buffer = { events: [], complete: false, bytes: 0 };
        this.buffers.set(channel, buffer);
      }
      // Always buffer terminal events; skip non-terminal if at capacity
      // on EITHER the event-count OR byte budget; never buffer
      // high-volume types (token, partial_object) per spec/16 §5.2 —
      // late subscribers reconstruct the same info from structural
      // events.
      const event = data as { type?: string };
      const isTerminal = event.type === 'done' || event.type === 'error';
      const isUnbuffered = event.type !== undefined && UNBUFFERED_EVENT_TYPES.has(event.type);
      if (!isUnbuffered) {
        const msgBytes = Buffer.byteLength(msg, 'utf8');
        const atCountCap = buffer.events.length >= this.maxEventsPerBuffer;
        const atByteCap = buffer.bytes + msgBytes > this.maxBytesPerBuffer;
        if (isTerminal || (!atCountCap && !atByteCap)) {
          buffer.events.push({ msg, data });
          buffer.bytes += msgBytes;
        }
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
