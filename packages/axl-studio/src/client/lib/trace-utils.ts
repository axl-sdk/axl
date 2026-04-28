import type {
  AxlEvent,
  AxlEventOf,
  AgentCallStartData,
  AgentCallEndData,
  GuardrailData,
  SchemaCheckData,
  ValidateData,
  ToolApprovalData,
} from './types';

/**
 * Per-event-type bar/dot color. Organized by family — start/end pairs share
 * one color (the type label disambiguates), and failure state is layered on
 * top via `getEventColor` → `isFailureEvent` (always wins, returns red-500).
 *
 * Design rules:
 *   - Red is reserved for failure (set on the leaf `tool_denied` and applied
 *     dynamically by `isFailureEvent` to gate/verify/ask_end/workflow_end
 *     payload-encoded failures across the union).
 *   - Cool hues are rationed to avoid blue ≈ sky ≈ violet ≈ teal at dot size.
 *   - Streaming and diagnostic events (`token`, `partial_object`, `log`) use
 *     muted slate to recede behind structural events.
 *   - One shade per family — saturation gradients within a family read as
 *     noise on a small dot; the event type label already distinguishes pairs.
 */
export const EVENT_COLORS: Record<string, string> = {
  // ── Lifecycle markers ──────────────────────────────────────────────
  workflow_start: 'bg-green-500',
  workflow_end: 'bg-green-500',
  ask_start: 'bg-sky-500',
  ask_end: 'bg-sky-500',

  // ── Agent activity (LLM call lifecycle) ────────────────────────────
  agent_call_start: 'bg-blue-500',
  agent_call_end: 'bg-blue-500',

  // ── Tool activity ──────────────────────────────────────────────────
  tool_call_start: 'bg-purple-500',
  tool_call_end: 'bg-purple-500',
  // tool_approval is a sub-event of the tool lifecycle; lighter shade
  // distinguishes it without leaving the family. Denial overrides to red
  // via `isFailureEvent`.
  tool_approval: 'bg-purple-400',
  // Failure-coded leaf (always denied) — `isFailureEvent` also returns
  // true so the red-500 override applies; default kept red-400 so the
  // palette table still reads as "this type means failure."
  tool_denied: 'bg-red-400',

  // ── Routing (handoff + delegate) ───────────────────────────────────
  handoff_start: 'bg-amber-500',
  handoff_return: 'bg-amber-500',
  delegate: 'bg-amber-500',

  // ── Validation pipeline ────────────────────────────────────────────
  // `pipeline(failed)` is overridden to red via `isFailureEvent`; default
  // covers `start` + `committed` so they don't read as failures.
  pipeline: 'bg-violet-500',
  // Legacy gate events (will collapse into `pipeline` over time). Same
  // family, lighter shade so they sit visually below pipeline.
  guardrail: 'bg-violet-400',
  schema_check: 'bg-violet-400',
  validate: 'bg-violet-400',

  // ── Verify (output validation primitive) ───────────────────────────
  verify: 'bg-teal-500',

  // ── Memory ops ─────────────────────────────────────────────────────
  // Three closely-related operations share one color — the type label
  // already says which (remember/recall/forget). Three near-identical
  // emerald shades were indistinguishable at dot size.
  memory_remember: 'bg-emerald-500',
  memory_recall: 'bg-emerald-500',
  memory_forget: 'bg-emerald-500',

  // ── Durable execution checkpoints ──────────────────────────────────
  // Persistence/storage family — same emerald hue as memory ops with a
  // lighter shade so they read as "data persistence" without competing
  // visually with memory recalls.
  checkpoint_save: 'bg-emerald-400',
  checkpoint_replay: 'bg-emerald-400',

  // ── Human-in-the-loop ──────────────────────────────────────────────
  // Yellow = pending / needs attention. The pause is a meaningful trace
  // landmark — yellow makes it easy to spot in long executions.
  await_human: 'bg-yellow-500',
  await_human_resolved: 'bg-yellow-500',

  // ── Streaming / diagnostic (de-emphasized) ─────────────────────────
  token: 'bg-slate-300',
  partial_object: 'bg-slate-300',
  log: 'bg-slate-400',

  // ── Terminal markers ───────────────────────────────────────────────
  // Distinct from log/token slate so the terminal `done` doesn't visually
  // disappear into the stream of de-emphasized rows above it.
  done: 'bg-zinc-700',
  error: 'bg-red-500',
};

/**
 * Sentinel color for forward-compat — surfaced when the client sees an event
 * type the palette doesn't know about. Distinct from `done` so a new variant
 * doesn't masquerade as a terminal marker.
 */
const UNKNOWN_EVENT_COLOR = 'bg-pink-400';

/**
 * Returns `true` when the event represents a failure signal in its payload —
 * a blocked guardrail, invalid schema/validate check, failed verify, denied
 * tool, aborted workflow, or `log` event carrying an `error` field (the
 * memory-audit events emit `error` on the failure path).
 */
export function isFailureEvent(event: AxlEvent): boolean {
  switch (event.type) {
    case 'tool_denied':
      return true;
    case 'guardrail':
      // GuardrailData uses `blocked: boolean`. Input/output guardrails both
      // share this shape; either one being blocked means failure.
      return event.data?.blocked === true;
    case 'schema_check':
    case 'validate':
      // SchemaCheckData / ValidateData both expose `valid: boolean` (not
      // optional in the strict union — the runtime always populates it).
      return event.data?.valid === false;
    case 'pipeline':
      // The unified-event-model retry lifecycle: `failed` status means the
      // gate rejected the attempt and a retry is queued. Spec §4.2.
      return event.status === 'failed';
    case 'verify':
      return event.data?.passed === false;
    case 'tool_approval':
      return event.data?.approved === false;
    case 'ask_end':
      // Discriminated outcome — ask-internal failures surface here per
      // spec decision 9.
      return event.outcome.ok === false;
    case 'workflow_end':
      return event.data?.status === 'failed' || event.data?.aborted === true;
    case 'log': {
      // `log.data` is `unknown` by design — narrow defensively.
      const d = event.data as { error?: unknown } | undefined;
      return d != null && typeof d === 'object' && 'error' in d && d.error != null;
    }
    default:
      return false;
  }
}

/**
 * Type-only color lookup (back-compat for call sites that don't have the
 * whole event). Prefer `getEventColor(event)` when possible — it reflects
 * failure state in the payload.
 */
export function getBarColor(type: string): string {
  return EVENT_COLORS[type] ?? UNKNOWN_EVENT_COLOR;
}

/**
 * Payload-aware color lookup. Gate/verify/tool-approval/workflow_end/log
 * events render red when their payload indicates failure so the user can
 * spot failure clusters in the trace waterfall without expanding every row.
 */
export function getEventColor(event: AxlEvent): string {
  if (isFailureEvent(event)) return 'bg-red-500';
  return getBarColor(event.type);
}

/**
 * Visual indent depth for a trace event in the waterfall view.
 *
 * `depth` is set from the ALS frame for AskScoped events (root = 0; +1 per
 * nested ask). It's not present on out-of-ask variants (`workflow_*`,
 * `done`) and on `handoff_*` (which carries `sourceDepth`/`targetDepth`
 * separately because it spans two asks). For those, we fall back to 0 so
 * the waterfall renders them at the root indent level.
 */
export function getDepth(event: AxlEvent): number {
  // `'depth' in event` narrows out variants where `depth` isn't declared
  // (workflow_*, handoff_*, done). For variants where depth is on
  // `Partial<AskScoped>` (log/memory_*/checkpoint_*/await_human/error/
  // gate events), the field may be undefined at runtime — guard with a
  // typeof check.
  if ('depth' in event && typeof event.depth === 'number') return event.depth;
  return 0;
}

/**
 * Per-event-type data narrowers. These exist as a small ergonomic layer
 * over `event.type === '...'` narrowing — both forms work, but the helpers
 * keep TraceEventList's body renderers (which switch on event.type and
 * reach into `event.data`) terse.
 *
 * Returns `null` instead of `undefined` so call sites can early-return on
 * a single check (the data field is required on most variants but the
 * helpers stay null-safe for forward-compat with future emit changes).
 */

/**
 * Unified gate-event data shape. Combines the on-pass (`valid: true`) and
 * on-fail (`blocked: true` for guardrail; `valid: false` for schema_check
 * /validate) cases into one read shape so the renderer doesn't have to
 * branch on event.type.
 */
export type GateCheckData = {
  valid?: boolean;
  blocked?: boolean;
  guardrailType?: 'input' | 'output';
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  feedbackMessage?: string;
};

export function getAgentCallStartData(event: AxlEvent): AgentCallStartData | null {
  if (event.type !== 'agent_call_start') return null;
  return event.data ?? null;
}

export function getAgentCallEndData(event: AxlEvent): AgentCallEndData | null {
  if (event.type !== 'agent_call_end') return null;
  return event.data ?? null;
}

export function getGateData(event: AxlEvent): GateCheckData | null {
  // Three variants share a normalized read shape — `guardrail` carries
  // `blocked` while `schema_check`/`validate` carry `valid`. Combining
  // them via the shared `GateCheckData` lets the renderer treat all three
  // uniformly.
  if (event.type === 'guardrail') {
    const d: GuardrailData | undefined = event.data;
    return d ?? null;
  }
  if (event.type === 'schema_check') {
    const d: SchemaCheckData | undefined = event.data;
    return d ?? null;
  }
  if (event.type === 'validate') {
    const d: ValidateData | undefined = event.data;
    return d ?? null;
  }
  return null;
}

export function getToolApprovalData(event: AxlEvent): ToolApprovalData | null {
  if (event.type !== 'tool_approval') return null;
  return event.data ?? null;
}

/** Returns true if this agent_call (start or end) is a retry triggered by a failed gate. */
export function isRetryCall(event: AxlEvent): boolean {
  if (event.type === 'agent_call_start') return !!event.data?.retryReason;
  if (event.type === 'agent_call_end') return !!event.data?.retryReason;
  return false;
}

// `AxlEventOf` is re-exported so importers of this module can narrow
// without reaching into the client types barrel. Unused-export warnings
// are suppressed by the import being used in the comment above (the
// re-export is the value). Keeping it on the public surface for callers
// that need explicit variant types.
export type { AxlEventOf };
