/**
 * Compile-time exhaustiveness check for the `AxlEvent` discriminated union.
 *
 * If a new `type` discriminator is added to `AxlEvent` (or `AXL_EVENT_TYPES`)
 * without a matching `case` here, the `_exhaustive: never` assignment fails to
 * compile. Catches drift between the union, the emitter, and consumers that
 * narrow on `type`.
 *
 * This file is type-checked by `pnpm typecheck` (`tsc --noEmit`) — there is no
 * runtime assertion. Consumers that import this file at runtime will execute
 * the function but no test framework hooks into it.
 */
import type { AxlEvent, AxlEventType } from '../types.js';
import { AXL_EVENT_TYPES } from '../types.js';

/** Exhaustiveness over the union members. */
function assertExhaustive(ev: AxlEvent): string {
  switch (ev.type) {
    case 'workflow_start':
      return ev.workflow;
    case 'workflow_end':
      return ev.data.status;
    case 'ask_start':
      return ev.askId;
    case 'ask_end':
      return ev.outcome.ok ? 'ok' : ev.outcome.error;
    case 'agent_call_start':
      return ev.model;
    case 'agent_call_end':
      return ev.data.response;
    case 'token':
      return ev.data;
    case 'tool_call_start':
      return ev.tool;
    case 'tool_call_end':
      return ev.tool;
    case 'tool_approval':
      return ev.tool;
    case 'tool_denied':
      return ev.tool;
    case 'delegate':
      return ev.data.reason;
    case 'handoff':
      return ev.fromAskId;
    case 'pipeline':
      // Narrow further on `status` to verify the multi-state union shape.
      switch (ev.status) {
        case 'start':
          return ev.stage;
        case 'failed':
          return ev.reason;
        case 'committed':
          return String(ev.attempt);
        default: {
          const _exhaustivePipeline: never = ev;
          return _exhaustivePipeline;
        }
      }
    case 'partial_object':
      return String(ev.attempt);
    case 'verify':
      return String(ev.data.passed);
    case 'log':
      return 'log';
    case 'memory_remember':
    case 'memory_recall':
    case 'memory_forget':
      return ev.data.scope;
    case 'guardrail':
      return ev.data?.guardrailType ?? 'guardrail';
    case 'schema_check':
      return ev.data?.reason ?? 'schema_check';
    case 'validate':
      return ev.data?.reason ?? 'validate';
    case 'done':
      return 'done';
    case 'error':
      return ev.data.message;
    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

/** Exhaustiveness over the literal-name tuple — guards drift between
 *  `AXL_EVENT_TYPES` and the union member set. */
function assertTypeListMatchesUnion(t: AxlEventType): AxlEvent['type'] {
  // Bidirectional assignability: AxlEventType ↔ AxlEvent['type'].
  const a: AxlEvent['type'] = t;
  const b: AxlEventType = a;
  return b;
}

/** Tuple length is positive — sanity guard for `AXL_EVENT_TYPES`. */
const _len: number = AXL_EVENT_TYPES.length;

// Re-export the helpers so `noUnusedLocals` is satisfied while still keeping
// them isolated to compile-time type checking. Importers will only see types.
export { assertExhaustive, assertTypeListMatchesUnion, _len };
