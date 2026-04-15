import { useState, useCallback, useEffect, useRef } from 'react';
import { useWs } from './use-ws';
import type { StreamEvent } from '../lib/types';

type StreamState = {
  tokens: string;
  events: StreamEvent[];
  done: boolean;
  error: string | null;
  result: unknown;
};

const INITIAL_STATE: StreamState = {
  tokens: '',
  events: [],
  done: false,
  error: null,
  result: null,
};

/**
 * Subscribe to a WS execution stream and accumulate tokens + events.
 *
 * Transition handling (subtle — read carefully before changing):
 *
 *   null → id:  "New stream starting". Fully reset to INITIAL_STATE so
 *               the UI starts from a clean slate.
 *   id → newId: Same as above — wipe the previous run's data.
 *   id → null:  "Run just finished, about to stop listening". Clear
 *               only the gate fields (`done` / `result` / `error`) so
 *               the panel's adoption effect doesn't re-fire with stale
 *               data on the next render, but KEEP `events` / `tokens`
 *               so the just-completed run's timeline stays visible
 *               until the user starts a new run.
 *
 * Without the gate-only clear on `id → null`, the next run would adopt
 * the previous run's stale `{ done: true, result: ... }` (the
 * "stale result on back-to-back run" bug). Without the `events`-preserve
 * on `id → null`, the just-completed run's timeline would disappear the
 * instant the adoption effect nulls out executionId (the "events flash
 * for a brief second" regression).
 */
export function useWsStream(executionId: string | null): StreamState {
  const [state, setState] = useState<StreamState>(INITIAL_STATE);
  const prevId = useRef<string | null>(null);

  useEffect(() => {
    if (executionId === prevId.current) return;
    const prev = prevId.current;
    prevId.current = executionId;

    if (executionId !== null) {
      // New stream starting (null→id or id→newId): wipe everything.
      setState(INITIAL_STATE);
    } else if (prev !== null) {
      // Just-completed stream going quiet (id→null): keep the events
      // and tokens visible, but clear the adoption gate so the next
      // run's setup render can't re-trigger adoption on stale values.
      setState((s) => ({ ...s, done: false, result: null, error: null }));
    }
  }, [executionId]);

  const handleEvent = useCallback((data: unknown) => {
    const event = data as StreamEvent;
    setState((prev) => {
      switch (event.type) {
        case 'token':
          return { ...prev, tokens: prev.tokens + event.data, events: [...prev.events, event] };
        case 'done':
          return { ...prev, done: true, result: event.data, events: [...prev.events, event] };
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
