import type { TraceEvent } from './types';

export const EVENT_COLORS: Record<string, string> = {
  agent_call: 'bg-blue-500',
  tool_call: 'bg-purple-500',
  tool_call_complete: 'bg-purple-400',
  workflow_start: 'bg-green-500',
  workflow_complete: 'bg-green-400',
  handoff: 'bg-amber-500',
  await_human: 'bg-red-500',
  vote_start: 'bg-cyan-500',
  spawn: 'bg-indigo-500',
};

export function getBarColor(type: string): string {
  return EVENT_COLORS[type] ?? 'bg-slate-500';
}

export function getDepth(event: TraceEvent): number {
  const type = event.type;
  if (type === 'workflow_start' || type === 'workflow_complete') return 0;
  if (type === 'agent_call' || type === 'spawn' || type === 'vote_start') return 1;
  if (type === 'tool_call' || type === 'tool_call_complete' || type === 'handoff') return 2;
  return 1;
}
