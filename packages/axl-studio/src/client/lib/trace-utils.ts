import type { AxlEvent } from './types';

export const EVENT_COLORS: Record<string, string> = {
  agent_call_end: 'bg-blue-500',
  tool_call_end: 'bg-purple-500',
  tool_approval: 'bg-purple-300',
  tool_denied: 'bg-red-400',
  workflow_start: 'bg-green-500',
  workflow_end: 'bg-green-400',
  handoff: 'bg-amber-500',
  delegate: 'bg-amber-400',
  await_human: 'bg-red-500',
  vote_start: 'bg-cyan-500',
  spawn: 'bg-indigo-500',
  guardrail: 'bg-rose-400',
  schema_check: 'bg-teal-500',
  validate: 'bg-teal-400',
  verify: 'bg-teal-300',
  log: 'bg-slate-400',
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
  if (type === 'verify') {
    const d = event.data as { passed?: boolean } | undefined;
    return d?.passed === false;
  }
  if (type === 'tool_approval') {
    const d = event.data as { approved?: boolean } | undefined;
    return d?.approved === false;
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

export function getDepth(event: AxlEvent): number {
  const type = event.type;
  // Nested events (emitted from a child context inside a tool handler) get an
  // extra indent so the visual hierarchy matches the actual call graph. The
  // extra depth is additive on top of the type-based depth below.
  const nestedBoost = event.parentToolCallId ? 2 : 0;
  if (type === 'workflow_start' || type === 'workflow_end') return 0 + nestedBoost;
  if (type === 'agent_call_end' || type === 'spawn' || type === 'vote_start' || type === 'delegate')
    return 1 + nestedBoost;
  if (
    type === 'tool_call_end' ||
    type === 'tool_approval' ||
    type === 'tool_denied' ||
    type === 'handoff' ||
    type === 'guardrail' ||
    type === 'schema_check' ||
    type === 'validate' ||
    type === 'verify'
  )
    return 2 + nestedBoost;
  return 1 + nestedBoost;
}

/** Event data narrowers — mirrors packages/axl/src/types.ts. Loose on client. */
export type AgentCallData = {
  prompt?: string;
  response?: string;
  system?: string;
  thinking?: string;
  params?: Record<string, unknown>;
  turn?: number;
  retryReason?: 'schema' | 'validate' | 'guardrail';
  messages?: Array<{ role: string; content: string }>;
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

export function getAgentCallData(event: AxlEvent): AgentCallData | null {
  if (event.type !== 'agent_call_end' || !event.data) return null;
  return event.data as AgentCallData;
}

export function getGateData(event: AxlEvent): GateCheckData | null {
  if (event.type !== 'guardrail' && event.type !== 'schema_check' && event.type !== 'validate')
    return null;
  return (event.data ?? null) as GateCheckData | null;
}

/** Returns true if this agent_call is a retry triggered by a failed gate. */
export function isRetryCall(event: AxlEvent): boolean {
  const d = getAgentCallData(event);
  return !!d?.retryReason;
}
