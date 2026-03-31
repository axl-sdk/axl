import type {
  ApiResponse,
  WorkflowSummary,
  ToolSummary,
  ToolDetail,
  AgentSummary,
  AgentDetail,
  ExecutionInfo,
  SessionSummary,
  SessionDetail,
  CostData,
  MemoryEntry,
  PendingDecision,
  HealthData,
  RegisteredEval,
  EvalHistoryEntry,
} from './types';

const BASE = (window.__AXL_STUDIO_BASE__ ?? '') + '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.ok) {
    throw new Error(body.error.message);
  }
  return body.data;
}

// ── Health ─────────────────────────────────────────────────────────
export const fetchHealth = () => request<HealthData>('/health');

// ── Workflows ──────────────────────────────────────────────────────
export const fetchWorkflows = () => request<WorkflowSummary[]>('/workflows');
export const fetchWorkflow = (name: string) =>
  request<{ name: string; inputSchema: unknown; outputSchema: unknown }>(
    `/workflows/${encodeURIComponent(name)}`,
  );
export const executeWorkflow = (name: string, input: unknown, stream = false) =>
  request<{ result?: unknown; executionId?: string; streaming?: boolean }>(
    `/workflows/${encodeURIComponent(name)}/execute`,
    { method: 'POST', body: JSON.stringify({ input, stream }) },
  );

// ── Executions ─────────────────────────────────────────────────────
export const fetchExecutions = () => request<ExecutionInfo[]>('/executions');
export const fetchExecution = (id: string) =>
  request<ExecutionInfo>(`/executions/${encodeURIComponent(id)}`);
export const abortExecution = (id: string) =>
  request<{ aborted: boolean }>(`/executions/${encodeURIComponent(id)}/abort`, { method: 'POST' });

// ── Sessions ───────────────────────────────────────────────────────
export const fetchSessions = () => request<SessionSummary[]>('/sessions');
export const fetchSession = (id: string) =>
  request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
export const sendSessionMessage = (id: string, message: string) =>
  request<{ result: unknown }>(`/sessions/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
export const streamSessionMessage = (id: string, message: string) =>
  request<{ executionId: string; streaming: boolean }>(
    `/sessions/${encodeURIComponent(id)}/stream`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  );
export const deleteSession = (id: string) =>
  request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ── Agents ─────────────────────────────────────────────────────────
export const fetchAgents = () => request<AgentSummary[]>('/agents');
export const fetchAgent = (name: string) =>
  request<AgentDetail>(`/agents/${encodeURIComponent(name)}`);

// ── Tools ──────────────────────────────────────────────────────────
export const fetchTools = () => request<ToolSummary[]>('/tools');
export const fetchTool = (name: string) =>
  request<ToolDetail>(`/tools/${encodeURIComponent(name)}`);
export const testTool = (name: string, input: unknown) =>
  request<{ result: unknown }>(`/tools/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });

// ── Memory ─────────────────────────────────────────────────────────
export const fetchMemory = (scope: string) =>
  request<MemoryEntry[]>(`/memory/${encodeURIComponent(scope)}`);
export const fetchMemoryEntry = (scope: string, key: string) =>
  request<MemoryEntry>(`/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`);
export const saveMemoryEntry = (scope: string, key: string, value: unknown) =>
  request<{ saved: boolean }>(`/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
export const deleteMemoryEntry = (scope: string, key: string) =>
  request<{ deleted: boolean }>(`/memory/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
export const searchMemory = (query: string, scope?: string, limit?: number) =>
  request<{ results: unknown[] }>('/memory/search', {
    method: 'POST',
    body: JSON.stringify({ query, scope, limit }),
  });

// ── Decisions ──────────────────────────────────────────────────────
export const fetchDecisions = () => request<PendingDecision[]>('/decisions');
export const resolveDecision = (executionId: string, approved: boolean, reason?: string) =>
  request<{ resolved: boolean }>(`/decisions/${encodeURIComponent(executionId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ approved, reason }),
  });

// ── Costs ──────────────────────────────────────────────────────────
export const fetchCosts = () => request<CostData>('/costs');
export const resetCosts = () => request<{ reset: boolean }>('/costs/reset', { method: 'POST' });

// ── Evals ──────────────────────────────────────────────────────────
export const fetchEvals = () => request<RegisteredEval[]>('/evals');
export const fetchEvalHistory = () => request<EvalHistoryEntry[]>('/evals/history');
export const runRegisteredEval = (name: string) =>
  request<unknown>(`/evals/${encodeURIComponent(name)}/run`, { method: 'POST' });
export const compareEvals = (baseline: unknown, candidate: unknown) =>
  request<unknown>('/evals/compare', {
    method: 'POST',
    body: JSON.stringify({ baseline, candidate }),
  });

// ── Playground ─────────────────────────────────────────────────────
export const playgroundChat = (message: string, sessionId?: string, agent?: string) =>
  request<{ sessionId: string; executionId: string; streaming: boolean }>('/playground/chat', {
    method: 'POST',
    body: JSON.stringify({ message, sessionId, agent }),
  });
