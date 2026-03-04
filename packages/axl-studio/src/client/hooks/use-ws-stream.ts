import { useState, useCallback } from 'react';
import { useWs } from './use-ws';
import type { StreamEvent } from '../lib/types';

type StreamState = {
  tokens: string;
  events: StreamEvent[];
  done: boolean;
  error: string | null;
  result: unknown;
};

/**
 * Subscribe to a WS execution stream and accumulate tokens + events.
 */
export function useWsStream(executionId: string | null): StreamState {
  const [state, setState] = useState<StreamState>({
    tokens: '',
    events: [],
    done: false,
    error: null,
    result: null,
  });

  const handleEvent = useCallback((data: unknown) => {
    const event = data as StreamEvent;
    setState((prev) => {
      switch (event.type) {
        case 'token':
          return { ...prev, tokens: prev.tokens + event.data, events: [...prev.events, event] };
        case 'done':
          return { ...prev, done: true, result: event.result, events: [...prev.events, event] };
        case 'error':
          return { ...prev, done: true, error: event.message, events: [...prev.events, event] };
        default:
          return { ...prev, events: [...prev.events, event] };
      }
    });
  }, []);

  useWs(executionId ? `execution:${executionId}` : null, handleEvent);

  return state;
}
