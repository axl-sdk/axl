import { useState, useCallback, useEffect, useRef } from 'react';
import { useWs } from './use-ws';
// Post-spec/16: the wire carries `AxlEvent` directly. The legacy
// `StreamEvent` shape and the runtime translation layer that synthesized
// `agent_end` / `tool_result` / `step` from rich trace events are gone.
import type { AxlEvent } from '../lib/types';

type StreamState = {
  /** Concatenated root-only tokens (spec/16 §3.2): consumer filters on
   *  `event.depth === 0` so nested-ask tokens don't pollute the
   *  chat-bubble view. Callers that want nested tokens should iterate
   *  `events` directly. */
  tokens: string;
  events: AxlEvent[];
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
    const event = data as AxlEvent;
    setState((prev) => {
      switch (event.type) {
        case 'token': {
          // Root-only token accumulation so nested-ask tokens don't leak
          // into chat UIs. Consumers wanting nested tokens iterate the
          // `events` array and filter on `event.depth` themselves.
          // `token` is AskScoped (`depth: number` required) on the strict
          // union — but the WS payload arrives as `unknown` and a malformed
          // / pre-AskScoped event without `depth` should still land at the
          // root. `?? 0` preserves that back-compat behavior; pinned by
          // the "treats undefined depth as root" test.
          const depth = event.depth ?? 0;
          const nextTokens = depth === 0 ? prev.tokens + (event.data ?? '') : prev.tokens;
          return { ...prev, tokens: nextTokens, events: [...prev.events, event] };
        }
        case 'done': {
          // `done.data` is `{ result: unknown }` — required on the strict
          // variant. Defense-in-depth: if a malformed wire payload (older
          // runtime, redaction-stripped, filter pass-through) drops `data`
          // or `result`, fall back to `null` rather than crashing the SPA.
          return {
            ...prev,
            done: true,
            result: event.data?.result ?? null,
            events: [...prev.events, event],
          };
        }
        case 'error': {
          // `error.data` is `{ message: string; name?; code? }` — required
          // on the strict variant. Same defense-in-depth rationale as `done`.
          return {
            ...prev,
            done: true,
            error: event.data?.message || 'Unknown error',
            events: [...prev.events, event],
          };
        }
        default:
          return { ...prev, events: [...prev.events, event] };
      }
    });
  }, []);

  useWs(executionId ? `execution:${executionId}` : null, handleEvent);

  return state;
}
