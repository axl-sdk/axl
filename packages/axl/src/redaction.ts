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
import type {
  AxlEvent,
  AxlEventOf,
  AxlEventType,
  AxlEventV2,
  HistoricalAxlEvent,
  LegacyAxlEventV1,
  ToolCallOutcome,
  ToolCallRejectedData,
  ToolLifecycleEventV2,
} from './types.js';
import { getEventSchemaVersion } from './event-schema.js';

export const REDACTED = '[redacted]';

type LegacyEventType = LegacyAxlEventV1['type'];
type LegacyEventOf<T extends LegacyEventType> = Extract<LegacyAxlEventV1, { type: T }>;
type LegacyRuleFor<T extends LegacyEventType> = (event: LegacyEventOf<T>) => LegacyEventOf<T>;
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
  event: LegacyEventOf<T>,
): LegacyEventOf<T> {
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
  } as LegacyEventOf<T>;
}

function redactInputDescriptor<T extends { parts: readonly unknown[] }>(input: T): T {
  return {
    ...input,
    parts: input.parts.map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part) || part.type === 'text')
        return part;
      const value = part as { locator?: unknown; label?: unknown };
      return {
        ...part,
        ...(value.locator !== undefined ? { locator: REDACTED } : {}),
        ...(value.label !== undefined ? { label: REDACTED } : {}),
      };
    }),
  } as T;
}

/** Shared rule for the three `memory_*` events. */
function redactMemory<T extends 'memory_remember' | 'memory_recall' | 'memory_forget'>(
  event: LegacyEventOf<T>,
): LegacyEventOf<T> {
  const d = (event as { data?: Record<string, unknown> }).data;
  if (!d || typeof d !== 'object') return event;
  return {
    ...event,
    data: walkObjectOneLevel(d, MEMORY_PRESERVE_KEYS),
  } as LegacyEventOf<T>;
}

/** Identity helper — used for variants that carry no user content. */
const passthrough = <T extends LegacyEventType>(e: LegacyEventOf<T>): LegacyEventOf<T> => e;

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
const LEGACY_REDACTION_RULES: { [K in LegacyEventType]: LegacyRuleFor<K> } = {
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
  ask_start: (e) => ({
    ...e,
    prompt: REDACTED,
    ...(e.input ? { input: redactInputDescriptor(e.input) } : {}),
  }),
  ask_end: (e) => ({
    ...e,
    outcome: e.outcome.ok ? { ok: true, result: REDACTED } : { ok: false, error: REDACTED },
  }),
  agent_call_start: (e) => {
    const d = e.data;
    const out = { ...d, prompt: REDACTED } as typeof d;
    if (d.input) {
      out.input = redactInputDescriptor(d.input);
    }
    if (d.messageInputs)
      out.messageInputs = d.messageInputs.map((entry) => ({
        ...entry,
        input: redactInputDescriptor(entry.input),
      }));
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
  delegate: passthrough as unknown as LegacyRuleFor<'delegate'>,
  handoff_start: (e) =>
    e.data.message !== undefined ? { ...e, data: { ...e.data, message: REDACTED } } : e,
  handoff_return: passthrough as unknown as LegacyRuleFor<'handoff_return'>,
  pipeline: (e) => (e.status === 'failed' ? { ...e, reason: REDACTED } : e),
  partial_object: (e) => ({ ...e, data: { ...e.data, object: REDACTED } }),
  // `path` is structural (schema-shape, no PII); `delta` is user content.
  // Scrub only the delta — preserving path keeps "which fields stream" telemetry.
  string_delta: (e) => ({ ...e, data: { ...e.data, delta: REDACTED } }),
  verify: (e) =>
    e.data.lastError !== undefined ? { ...e, data: { ...e.data, lastError: REDACTED } } : e,
  // `schema_diagnostic` carries only structural schema metadata — token counts,
  // thresholds, JSON-Schema field paths, a root type name, a tool name — none of
  // which is user content or PII (field paths are schema-shape, preserved like
  // `string_delta.path`). Passthrough, as an explicit reviewed decision.
  schema_diagnostic: passthrough as unknown as LegacyRuleFor<'schema_diagnostic'>,
  log: (e) => {
    if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return e;
    return { ...e, data: walkObjectOneLevel(e.data as Record<string, unknown>, LOG_PRESERVE_KEYS) };
  },
  memory_remember: redactMemory as unknown as LegacyRuleFor<'memory_remember'>,
  memory_recall: redactMemory as unknown as LegacyRuleFor<'memory_recall'>,
  memory_forget: redactMemory as unknown as LegacyRuleFor<'memory_forget'>,
  checkpoint_save: passthrough as unknown as LegacyRuleFor<'checkpoint_save'>,
  checkpoint_replay: passthrough as unknown as LegacyRuleFor<'checkpoint_replay'>,
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
  guardrail: redactGate as unknown as LegacyRuleFor<'guardrail'>,
  schema_check: redactGate as unknown as LegacyRuleFor<'schema_check'>,
  validate: redactGate as unknown as LegacyRuleFor<'validate'>,
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
function redactLegacyEvent(event: LegacyAxlEventV1): LegacyAxlEventV1 {
  const rule = LEGACY_REDACTION_RULES[event.type] as LegacyRuleFor<typeof event.type>;
  return rule(event as never);
}

function redactV2Outcome(outcome: ToolCallOutcome): ToolCallOutcome {
  switch (outcome.status) {
    case 'succeeded':
      return { ...outcome, result: REDACTED };
    case 'denied':
      return outcome.reason === undefined ? outcome : { ...outcome, reason: REDACTED };
    case 'cancelled':
      return {
        ...outcome,
        cancellation: {
          ...outcome.cancellation,
          ...('result' in outcome.cancellation ? { result: REDACTED } : {}),
          ...(outcome.cancellation.reason !== undefined ? { reason: REDACTED } : {}),
        },
      };
    case 'failed': {
      const failure = outcome.failure;
      return {
        ...outcome,
        failure: {
          ...failure,
          ...('result' in failure ? { result: REDACTED } : {}),
          error: {
            ...failure.error,
            message: REDACTED,
            ...(failure.error.cause !== undefined ? { cause: REDACTED } : {}),
          },
        } as typeof failure,
      };
    }
  }
}

function redactV2Rejection(data: ToolCallRejectedData): ToolCallRejectedData {
  switch (data.reason) {
    case 'unavailable':
      return data;
    case 'invalid_json':
      return { ...data, message: REDACTED };
    case 'invalid_arguments':
      return {
        ...data,
        args: REDACTED,
        issues: data.issues.map((issue) => ({
          ...issue,
          ...(issue.message !== undefined ? { message: REDACTED } : {}),
        })),
      };
  }
}

type V2ToolEventType = ToolLifecycleEventV2['type'];
type V2ToolRule<T extends V2ToolEventType> = (
  event: Extract<ToolLifecycleEventV2, { type: T }>,
) => Extract<ToolLifecycleEventV2, { type: T }>;

/** Exhaustive v2 tool redaction table, installed before the v2 writer switch. */
const V2_TOOL_REDACTION_RULES: { [K in V2ToolEventType]: V2ToolRule<K> } = {
  tool_call_start: (event) => ({
    ...event,
    data: { ...event.data, args: REDACTED },
  }),
  tool_call_end: (event) => ({
    ...event,
    data: {
      ...event.data,
      args: REDACTED,
      outcome: redactV2Outcome(event.data.outcome),
    },
  }),
  tool_call_rejected: (event) => ({
    ...event,
    data: redactV2Rejection(event.data),
  }),
};

type CommonV2EventType = Exclude<AxlEventType, V2ToolEventType>;

function reuseLegacyRule<T extends CommonV2EventType>(type: T): RuleFor<T> {
  return LEGACY_REDACTION_RULES[type as LegacyEventType] as unknown as RuleFor<T>;
}

const COMMON_V2_REDACTION_RULES = {
  workflow_start: reuseLegacyRule('workflow_start'),
  workflow_end: reuseLegacyRule('workflow_end'),
  ask_start: reuseLegacyRule('ask_start'),
  ask_end: reuseLegacyRule('ask_end'),
  agent_call_start: reuseLegacyRule('agent_call_start'),
  agent_call_end: reuseLegacyRule('agent_call_end'),
  token: reuseLegacyRule('token'),
  tool_approval: reuseLegacyRule('tool_approval'),
  delegate: reuseLegacyRule('delegate'),
  handoff_start: reuseLegacyRule('handoff_start'),
  handoff_return: reuseLegacyRule('handoff_return'),
  pipeline: reuseLegacyRule('pipeline'),
  partial_object: reuseLegacyRule('partial_object'),
  string_delta: reuseLegacyRule('string_delta'),
  verify: reuseLegacyRule('verify'),
  schema_diagnostic: reuseLegacyRule('schema_diagnostic'),
  log: reuseLegacyRule('log'),
  memory_remember: reuseLegacyRule('memory_remember'),
  memory_recall: reuseLegacyRule('memory_recall'),
  memory_forget: reuseLegacyRule('memory_forget'),
  checkpoint_save: reuseLegacyRule('checkpoint_save'),
  checkpoint_replay: reuseLegacyRule('checkpoint_replay'),
  await_human: reuseLegacyRule('await_human'),
  await_human_resolved: reuseLegacyRule('await_human_resolved'),
  guardrail: reuseLegacyRule('guardrail'),
  schema_check: reuseLegacyRule('schema_check'),
  validate: reuseLegacyRule('validate'),
  done: reuseLegacyRule('done'),
  error: reuseLegacyRule('error'),
} satisfies { [K in CommonV2EventType]: RuleFor<K> };

/** Current-writer redaction rules. The mapped type makes every live event
 * discriminator an explicit compile-time redaction decision. */
export const REDACTION_RULES = {
  ...COMMON_V2_REDACTION_RULES,
  ...V2_TOOL_REDACTION_RULES,
} satisfies { [K in AxlEventType]: RuleFor<K> };

export function redactEvent(event: AxlEvent): AxlEvent {
  const rule = REDACTION_RULES[event.type] as RuleFor<typeof event.type>;
  return rule(event as never);
}

/** Redact either persisted schema without reinterpreting its lifecycle. */
export function redactHistoricalEvent(event: HistoricalAxlEvent): HistoricalAxlEvent {
  if (getEventSchemaVersion(event) === 1) {
    return redactLegacyEvent(event as LegacyAxlEventV1);
  }
  return redactEvent(event as AxlEventV2);
}
