import type { BroadcastTarget } from './connection-manager.js';
import type { ConnectionManager } from './connection-manager.js';

/** Valid channel prefixes for subscription. */
const VALID_CHANNEL_PREFIXES = ['execution:', 'trace:', 'costs', 'decisions'];
const MAX_CHANNEL_LENGTH = 256;

/**
 * Handle a single WebSocket message according to the Studio protocol.
 * Returns a JSON string to send back to the client, or null for no response.
 *
 * Used by both the Hono WS handler (ws/handler.ts) and the Node.js
 * middleware (middleware.ts) to keep the protocol in one place.
 */
export function handleWsMessage(
  raw: string,
  socket: BroadcastTarget,
  connMgr: ConnectionManager,
): string | null {
  // Reject oversized messages (64KB limit)
  if (raw.length > 65536) {
    return JSON.stringify({ type: 'error', message: 'Message too large' });
  }

  let msg: { type: string; channel?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return JSON.stringify({ type: 'error', message: 'Invalid JSON' });
  }

  switch (msg.type) {
    case 'subscribe': {
      const error = validateChannel(msg.channel);
      if (error) return JSON.stringify({ type: 'error', message: error });
      connMgr.subscribe(socket, msg.channel!);
      return JSON.stringify({ type: 'subscribed', channel: msg.channel });
    }
    case 'unsubscribe': {
      const error = validateChannel(msg.channel);
      if (error) return JSON.stringify({ type: 'error', message: error });
      connMgr.unsubscribe(socket, msg.channel!);
      return JSON.stringify({ type: 'unsubscribed', channel: msg.channel });
    }
    case 'ping':
      return JSON.stringify({ type: 'pong' });
    default:
      return JSON.stringify({ type: 'error', message: 'Unknown message type' });
  }
}

function validateChannel(channel: unknown): string | null {
  if (typeof channel !== 'string' || !channel) {
    return 'Missing or invalid channel';
  }
  if (channel.length > MAX_CHANNEL_LENGTH) {
    return `Channel name exceeds ${MAX_CHANNEL_LENGTH} characters`;
  }
  if (!VALID_CHANNEL_PREFIXES.some((p) => channel === p || channel.startsWith(p))) {
    return `Invalid channel: ${channel}`;
  }
  return null;
}
