type WsCallback = (data: unknown) => void;

/**
 * Singleton WebSocket client with channel subscription support.
 */
class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<WsCallback>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${window.location.host}/ws`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      // Re-subscribe to all active channels
      for (const channel of this.listeners.keys()) {
        this.send({ type: 'subscribe', channel });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'event' && msg.channel) {
          const cbs = this.listeners.get(msg.channel);
          if (cbs) {
            for (const cb of cbs) cb(msg.data);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(channel: string, callback: WsCallback): () => void {
    let cbs = this.listeners.get(channel);
    if (!cbs) {
      cbs = new Set();
      this.listeners.set(channel, cbs);
      this.send({ type: 'subscribe', channel });
    }
    cbs.add(callback);
    this.connect();

    return () => {
      cbs!.delete(callback);
      if (cbs!.size === 0) {
        this.listeners.delete(channel);
        this.send({ type: 'unsubscribe', channel });
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export const wsClient = new WsClient();
