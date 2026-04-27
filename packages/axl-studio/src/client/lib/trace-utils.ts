import type { AxlEvent } from './types';

/**
 * Per-event-type bar/dot color. Organized by family — start/end pairs share
 * one color (the type label disambiguates), and failure state is layered on
 * top via `getEventColor` → `isFailureEvent` (always wins, returns red-500).
 *
 * Design rules:
 *   - Red is reserved for failure (set on the leaf `tool_denied` and applied
 *     dynamically by `isFailureEvent` to *_failed states across the union).
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
  done: 'bg-slate-500',
  error: 'bg-red-500',
};

/**
 * Returns `true` when the event represents a failure signal in its payload —
 * a blocked guardrail, invalid schema/validate check, failed verify, denied
 * tool, aborted workflow, or `log` event carrying an `error` field (the
 * memory-audit events emit `error` on the failure path).
 */
export function isFailureEvent(event: AxlEvent): boolean {
  const type = event.type;
  if (type === 'tool_denied') return true;
  if (type === 'guardrail' || type === 'schema_check' || type === 'validate') {
    const d = event.data as { valid?: boolean; blocked?: boolean } | undefined;
    // Output-gate events use `valid: false`; input/output guardrails use `blocked: true`.
    return d?.valid === false || d?.blocked === true;
  }
  if (type === 'pipeline') {
    // The unified-event-model retry lifecycle: `failed` status means the
    // gate rejected the attempt and a retry is queued. Spec §4.2.
    return (event as { status?: string }).status === 'failed';
  }
  if (type === 'verify') {
    const d = event.data as { passed?: boolean } | undefined;
    return d?.passed === false;
  }
  if (type === 'tool_approval') {
    const d = event.data as { approved?: boolean } | undefined;
    return d?.approved === false;
  }
  if (type === 'ask_end') {
    // Discriminated outcome — ask-internal failures surface here per
    // spec decision 9.
    const outcome = (event as { outcome?: { ok?: boolean } }).outcome;
    return outcome?.ok === false;
  }
  if (type === 'workflow_end') {
    const d = event.data as { status?: string; aborted?: boolean } | undefined;
    return d?.status === 'failed' || d?.aborted === true;
  }
  if (type === 'log') {
    const d = event.data as { error?: unknown } | undefined;
    return d?.error !== undefined && d?.error !== null;
  }
  return false;
}

/**
 * Type-only color lookup (back-compat for call sites that don't have the
 * whole event). Prefer `getEventColor(event)` when possible — it reflects
 * failure state in the payload.
 */
export function getBarColor(type: string): string {
  return EVENT_COLORS[type] ?? 'bg-slate-500';
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
 * `depth` is a first-class field on every AxlEvent — set from the ALS
 * frame for ask-scoped events (root = 0; +1 per nested ask), and stamped
 * to 0 by `emitEvent` for out-of-ask events (workflow lifecycle, logs,
 * workflow-scope memory/checkpoint/await_human). The fallback only fires
 * for malformed/legacy events that bypassed the emitter.
 */
export function getDepth(event: AxlEvent): number {
  if (typeof event.depth === 'number') return event.depth;
  return 0;
}

/** Event data narrowers — mirrors packages/axl/src/types.ts. Loose on client. */
export type AgentCallStartData = {
  prompt?: string;
  system?: string;
  params?: Record<string, unknown>;
  turn?: number;
  retryReason?: 'schema' | 'validate' | 'guardrail';
  toolNames?: string[];
  messages?: Array<{ role: string; content: string }>;
};

export type AgentCallEndData = {
  response?: string;
  thinking?: string;
  turn?: number;
  retryReason?: 'schema' | 'validate' | 'guardrail';
};

export type GateCheckData = {
  valid?: boolean;
  blocked?: boolean;
  guardrailType?: 'input' | 'output';
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  feedbackMessage?: string;
};

export type ToolApprovalData = {
  approved: boolean;
  args: unknown;
  reason?: string;
};

export function getAgentCallStartData(event: AxlEvent): AgentCallStartData | null {
  if (event.type !== 'agent_call_start' || !event.data) return null;
  return event.data as AgentCallStartData;
}

export function getAgentCallEndData(event: AxlEvent): AgentCallEndData | null {
  if (event.type !== 'agent_call_end' || !event.data) return null;
  return event.data as AgentCallEndData;
}

export function getGateData(event: AxlEvent): GateCheckData | null {
  if (event.type !== 'guardrail' && event.type !== 'schema_check' && event.type !== 'validate')
    return null;
  return (event.data ?? null) as GateCheckData | null;
}

/** Returns true if this agent_call (start or end) is a retry triggered by a failed gate. */
export function isRetryCall(event: AxlEvent): boolean {
  if (event.type === 'agent_call_start') return !!getAgentCallStartData(event)?.retryReason;
  if (event.type === 'agent_call_end') return !!getAgentCallEndData(event)?.retryReason;
  return false;
}
