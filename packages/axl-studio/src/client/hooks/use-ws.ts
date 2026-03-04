import { useEffect, useRef } from 'react';
import { wsClient } from '../lib/ws';

/**
 * Subscribe to a WebSocket channel and call the callback on each event.
 */
export function useWs(channel: string | null, callback: (data: unknown) => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!channel) return;
    return wsClient.subscribe(channel, (data) => callbackRef.current(data));
  }, [channel]);
}
