import { useEffect, useRef } from 'react';
import { wsClient } from '../lib/ws';

/**
 * Subscribe to a WebSocket channel and call the callback on each event.
 */
export function useWs(
  channel: string | null,
  callback: (data: unknown) => void,
  onDisconnect?: () => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const disconnectRef = useRef(onDisconnect);
  disconnectRef.current = onDisconnect;

  useEffect(() => {
    if (!channel) return;
    const unsubscribe = wsClient.subscribe(channel, (data) => callbackRef.current(data));
    const unsubscribeConnection = wsClient.subscribeConnection?.((connected) => {
      if (!connected) disconnectRef.current?.();
    });
    return () => {
      unsubscribe();
      unsubscribeConnection?.();
    };
  }, [channel]);
}
