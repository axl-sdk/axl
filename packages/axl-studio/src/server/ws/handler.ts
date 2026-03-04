import type { WSContext } from 'hono/ws';
import type { ConnectionManager } from './connection-manager.js';
import type { WsClientMessage, WsServerMessage } from '../types.js';

/** Create WS event handlers for a connection. */
export function createWsHandlers(connMgr: ConnectionManager) {
  return {
    onOpen(_event: Event, ws: WSContext) {
      connMgr.add(ws);
    },

    onMessage(event: MessageEvent, ws: WSContext) {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        const err: WsServerMessage = { type: 'error', message: 'Invalid JSON' };
        ws.send(JSON.stringify(err));
        return;
      }

      switch (msg.type) {
        case 'subscribe': {
          connMgr.subscribe(ws, msg.channel);
          const reply: WsServerMessage = { type: 'subscribed', channel: msg.channel };
          ws.send(JSON.stringify(reply));
          break;
        }
        case 'unsubscribe': {
          connMgr.unsubscribe(ws, msg.channel);
          const reply: WsServerMessage = { type: 'unsubscribed', channel: msg.channel };
          ws.send(JSON.stringify(reply));
          break;
        }
        case 'ping': {
          const reply: WsServerMessage = { type: 'pong' };
          ws.send(JSON.stringify(reply));
          break;
        }
        default: {
          const err: WsServerMessage = { type: 'error', message: `Unknown message type` };
          ws.send(JSON.stringify(err));
        }
      }
    },

    onClose(_event: CloseEvent, ws: WSContext) {
      connMgr.remove(ws);
    },

    onError(_event: Event, ws: WSContext) {
      connMgr.remove(ws);
    },
  };
}
