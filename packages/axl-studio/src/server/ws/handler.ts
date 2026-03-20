import type { WSContext } from 'hono/ws';
import type { ConnectionManager } from './connection-manager.js';
import { handleWsMessage } from './protocol.js';

/** Create WS event handlers for a Hono WebSocket connection. */
export function createWsHandlers(connMgr: ConnectionManager) {
  return {
    onOpen(_event: Event, ws: WSContext) {
      connMgr.add(ws);
    },

    onMessage(event: MessageEvent, ws: WSContext) {
      const reply = handleWsMessage(String(event.data), ws, connMgr);
      if (reply) ws.send(reply);
    },

    onClose(_event: CloseEvent, ws: WSContext) {
      connMgr.remove(ws);
    },

    onError(_event: Event, ws: WSContext) {
      connMgr.remove(ws);
    },
  };
}
