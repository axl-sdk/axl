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

  // 413 is the canonical body-too-large status. Host framework body parsers
  // (Express, NestJS, Koa) reject oversize requests before they reach Studio's
  // handler, typically with text/html or text/plain. Some hosts use a JSON
  // error envelope, so check status first regardless of content-type and
  // surface a specific, actionable message pointing at the README.
  if (res.status === 413) {
    throw new Error(
      `Request body too large (HTTP 413). If you're importing a large eval file ` +
        `through an embedded Studio middleware, raise your host framework's JSON ` +
        `body limit on the Studio mount. See the Studio README "Host body limits" section.`,
    );
  }

  // Detect non-JSON responses (HTML error pages from host framework body
  // parsers, reverse proxies, auth layers, etc.) before attempting to parse.
  // Without this, `res.json()` throws "Unexpected token < in JSON at position 0"
  // which gives the user zero signal about what actually went wrong.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 200).trim();
    throw new Error(
      `Server returned HTTP ${res.status} with non-JSON response` + (snippet ? `: ${snippet}` : ''),
    );
  }

  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch (err) {
    throw new Error(
      `Failed to parse server response as JSON (HTTP ${res.status}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
export const runRegisteredEval = (name: string, options?: { runs?: number }) =>
  request<unknown>(`/evals/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    body: options?.runs && options.runs > 1 ? JSON.stringify({ runs: options.runs }) : undefined,
  });
export const rescoreEval = (name: string, resultId: string) =>
  request<unknown>(`/evals/${encodeURIComponent(name)}/rescore`, {
    method: 'POST',
    body: JSON.stringify({ resultId }),
  });

export const compareEvals = (
  baselineId: string | string[],
  candidateId: string | string[],
  options?: { thresholds?: Record<string, number> | number },
) =>
  request<unknown>('/evals/compare', {
    method: 'POST',
    body: JSON.stringify({ baselineId, candidateId, options }),
  });

export const importEvalResult = (result: unknown, evalName?: string) =>
  request<{ id: string; eval: string; timestamp: number }>('/evals/import', {
    method: 'POST',
    body: JSON.stringify({ result, eval: evalName }),
  });

export const deleteEvalHistoryEntry = (id: string) =>
  request<{ id: string; deleted: boolean }>(`/evals/history/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

// ── Playground ─────────────────────────────────────────────────────
export const playgroundChat = (message: string, sessionId?: string, agent?: string) =>
  request<{ sessionId: string; executionId: string; streaming: boolean }>('/playground/chat', {
    method: 'POST',
    body: JSON.stringify({ message, sessionId, agent }),
  });
