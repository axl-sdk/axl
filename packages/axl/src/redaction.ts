/**
 * Per-variant redaction rules for `AxlEvent`.
 *
 * `config.trace.redact` is an observability-boundary filter that scrubs
 * user/LLM content from events before they reach consumers. Two layers
 * historically applied this filter independently:
 *
 *   1. Core: `WorkflowContext.emitEvent()` — emit-time scrub before `onTrace`.
 *   2. Studio: `redactStreamEvent()` — wire-boundary scrub before WS broadcast
 *      and again at REST serialization (`redactExecutionInfo`).
 *
 * Both layers walked the same `AxlEvent` discriminated union, with separate
 * if/else and switch/case ladders. Adding a new variant required updating
 * both. They had drifted: WS missed `workflow_start`/`workflow_end`,
 * `log`, and the full `memory_*` walk that core applied. Defense-in-depth
 * also broke for runtimes that flipped `redact` after emitting events —
 * REST reads of stored `ExecutionInfo.events` would leak fields the WS
 * layer didn't know to scrub.
 *
 * `REDACTION_RULES` is the single source of truth: a `Record<AxlEventType,
 * RuleFor<...>>` so adding a new variant to `AXL_EVENT_TYPES` without a
 * corresponding entry is a typecheck error. Every rule is pure (no
 * mutation), so the same rule runs at emit time and at the wire boundary
 * with identical results.
 *
 * Numeric/structural fields (`cost`, `tokens`, `duration`, `askId`,
 * `parentAskId`, `depth`, `agent`, `executionId`, `step`, `timestamp`,
 * `callId`, `tool`, `model`, `workflow`) are NEVER scrubbed — they're
 * non-PII observability metadata and load-bearing for cost rails. Rules
 * preserve these by spreading `{ ...event }` and only overriding the
 * specific user-content field(s) for that variant.
 */
import type { AxlEvent, AxlEventOf, AxlEventType } from './types.js';

export const REDACTED = '[redacted]';

/** Type-safe rule signature: takes a specific event variant, returns the same variant. */
type RuleFor<T extends AxlEventType> = (event: AxlEventOf<T>) => AxlEventOf<T>;

/**
 * Walk a one-level object, preserving structural keys and numeric/boolean
 * scalars while scrubbing strings and replacing nested arrays/null with
 * the redacted sentinel. Used by `log` and `memory_*` rules.
 *
 * Nested object fields (one level deep) get the same treatment: numerics
 * and booleans pass through; everything else becomes `[redacted]`. We
 * deliberately don't recurse beyond one level — `usage.tokens` /
 * `usage.cost` are the only structured-numeric fields we ship today, and
 * preserving them at two-level depth keeps cost-aggregation rails
 * working even under redaction.
 */
function walkObjectOneLevel(
  obj: Record<string, unknown>,
  preserveKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (preserveKeys.has(k) || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = REDACTED;
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      const innerOut: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(inner)) {
        if (typeof iv === 'number' || typeof iv === 'boolean') {
          innerOut[ik] = iv;
        } else {
          innerOut[ik] = REDACTED;
        }
      }
      out[k] = innerOut;
    } else {
      out[k] = REDACTED;
    }
  }
  return out;
}

const LOG_PRESERVE_KEYS: ReadonlySet<string> = new Set(['event']);
const MEMORY_PRESERVE_KEYS: ReadonlySet<string> = new Set(['scope']);

/** Shared rule for the legacy gate events (`guardrail` / `schema_check` / `validate`). */
function redactGate<T extends 'guardrail' | 'schema_check' | 'validate'>(
  event: AxlEventOf<T>,
): AxlEventOf<T> {
  const d = (event as { data?: { reason?: string; feedbackMessage?: string } }).data;
  if (!d) return event;
  if (d.reason === undefined && d.feedbackMessage === undefined) return event;
  return {
    ...event,
    data: {
      ...d,
      ...(d.reason !== undefined ? { reason: REDACTED } : {}),
      ...(d.feedbackMessage !== undefined ? { feedbackMessage: REDACTED } : {}),
    },
  } as AxlEventOf<T>;
}

/** Shared rule for the three `memory_*` events. */
function redactMemory<T extends 'memory_remember' | 'memory_recall' | 'memory_forget'>(
  event: AxlEventOf<T>,
): AxlEventOf<T> {
  const d = (event as { data?: Record<string, unknown> }).data;
  if (!d || typeof d !== 'object') return event;
  return {
    ...event,
    data: walkObjectOneLevel(d, MEMORY_PRESERVE_KEYS),
  } as AxlEventOf<T>;
}

/** Identity helper — used for variants that carry no user content. */
const passthrough = <T extends AxlEventType>(e: AxlEventOf<T>): AxlEventOf<T> => e;

/**
 * Per-variant rule table. Adding a new variant to `AXL_EVENT_TYPES`
 * without a corresponding entry here is a typecheck error — the
 * `Record<AxlEventType, ...>` mapped type forces exhaustiveness.
 *
 * For variants that ship no user content today (`delegate`,
 * `handoff_return`, `checkpoint_*`), the rule is `passthrough` — but
 * that's still an explicit, reviewed decision rather than a
 * silent omission.
 */
export const REDACTION_RULES: { [K in AxlEventType]: RuleFor<K> } = {
  workflow_start: (e) =>
    e.data.input !== undefined ? { ...e, data: { ...e.data, input: REDACTED } } : e,
  workflow_end: (e) => {
    const d = e.data;
    if (d.result === undefined && d.error === undefined) return e;
    return {
      ...e,
      data: {
        ...d,
        ...(d.result !== undefined ? { result: REDACTED } : {}),
        ...(d.error !== undefined ? { error: REDACTED } : {}),
      },
    };
  },
  ask_start: (e) => ({ ...e, prompt: REDACTED }),
  ask_end: (e) => ({
    ...e,
    outcome: e.outcome.ok ? { ok: true, result: REDACTED } : { ok: false, error: REDACTED },
  }),
  agent_call_start: (e) => {
    const d = e.data;
    const out = { ...d, prompt: REDACTED } as typeof d;
    if (d.system !== undefined) out.system = REDACTED;
    if (Array.isArray(d.messages)) {
      out.messages = [{ role: 'system', content: `[${d.messages.length} messages redacted]` }];
    }
    return { ...e, data: out };
  },
  agent_call_end: (e) => {
    const d = e.data;
    const out = { ...d, response: REDACTED } as typeof d;
    if (d.thinking !== undefined) out.thinking = REDACTED;
    if (d.error !== undefined) out.error = REDACTED;
    return { ...e, data: out };
  },
  token: (e) => ({ ...e, data: REDACTED }),
  tool_call_start: (e) => ({ ...e, data: { ...e.data, args: REDACTED } }),
  tool_call_end: (e) => ({ ...e, data: { ...e.data, args: REDACTED, result: REDACTED } }),
  tool_approval: (e) => ({
    ...e,
    data: {
      ...e.data,
      args: REDACTED,
      ...(e.data.reason !== undefined ? { reason: REDACTED } : {}),
    },
  }),
  tool_denied: (e) => {
    if (!e.data) return e;
    const d = e.data;
    if (d.args === undefined && d.reason === undefined) return e;
    return {
      ...e,
      data: {
        ...d,
        ...(d.args !== undefined ? { args: REDACTED } : {}),
        ...(d.reason !== undefined ? { reason: REDACTED } : {}),
      },
    };
  },
  delegate: passthrough as unknown as RuleFor<'delegate'>,
  handoff_start: (e) =>
    e.data.message !== undefined ? { ...e, data: { ...e.data, message: REDACTED } } : e,
  handoff_return: passthrough as unknown as RuleFor<'handoff_return'>,
  pipeline: (e) => (e.status === 'failed' ? { ...e, reason: REDACTED } : e),
  partial_object: (e) => ({ ...e, data: { ...e.data, object: REDACTED } }),
  verify: (e) =>
    e.data.lastError !== undefined ? { ...e, data: { ...e.data, lastError: REDACTED } } : e,
  log: (e) => {
    if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return e;
    return { ...e, data: walkObjectOneLevel(e.data as Record<string, unknown>, LOG_PRESERVE_KEYS) };
  },
  memory_remember: redactMemory as unknown as RuleFor<'memory_remember'>,
  memory_recall: redactMemory as unknown as RuleFor<'memory_recall'>,
  memory_forget: redactMemory as unknown as RuleFor<'memory_forget'>,
  checkpoint_save: passthrough as unknown as RuleFor<'checkpoint_save'>,
  checkpoint_replay: passthrough as unknown as RuleFor<'checkpoint_replay'>,
  await_human: (e) =>
    e.data.prompt !== undefined ? { ...e, data: { ...e.data, prompt: REDACTED } } : e,
  await_human_resolved: (e) => {
    const dec = e.data.decision;
    if (!dec) return e;
    const hasData = 'data' in dec && dec.data !== undefined;
    const hasReason = 'reason' in dec && dec.reason !== undefined;
    if (!hasData && !hasReason) return e;
    const scrubbed = { ...dec };
    if (hasData) (scrubbed as { data?: string }).data = REDACTED;
    if (hasReason) (scrubbed as { reason?: string }).reason = REDACTED;
    return { ...e, data: { ...e.data, decision: scrubbed } };
  },
  guardrail: redactGate as unknown as RuleFor<'guardrail'>,
  schema_check: redactGate as unknown as RuleFor<'schema_check'>,
  validate: redactGate as unknown as RuleFor<'validate'>,
  done: (e) => ({ ...e, data: { result: REDACTED } }),
  error: (e) => ({ ...e, data: { ...e.data, message: REDACTED } }),
};

/**
 * Apply the redaction rule for `event.type` and return a new event with
 * user-content fields scrubbed. Pure: never mutates the input.
 *
 * Caller responsibility: only invoke when redaction is enabled. The rules
 * unconditionally scrub — they don't gate on `config.trace.redact`. Both
 * `WorkflowContext.emitEvent` (core) and `redactStreamEvent` (Studio)
 * check the flag before calling this function.
 */
export function redactEvent(event: AxlEvent): AxlEvent {
  const rule = REDACTION_RULES[event.type] as RuleFor<typeof event.type>;
  return rule(event as never);
}
