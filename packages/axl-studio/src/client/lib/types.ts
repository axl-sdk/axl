declare global {
  interface Window {
    __AXL_STUDIO_BASE__?: string;
  }
}

/** API response envelope */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Workflow summary */
export type WorkflowSummary = {
  name: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

/** Tool summary */
export type ToolSummary = {
  name: string;
  description: string;
  inputSchema: unknown;
  sensitive: boolean;
  requireApproval: boolean;
};

/** Tool detail (from GET /api/tools/:name) */
export type ToolDetail = {
  name: string;
  description: string;
  inputSchema: unknown;
  sensitive: boolean;
  requireApproval: boolean;
  retry: { attempts?: number; backoff?: string };
  hasHooks: boolean;
  hooks: { hasBefore: boolean; hasAfter: boolean } | null;
};

/** Agent summary */
export type AgentSummary = {
  name: string;
  model: string;
  system: string;
  tools: string[];
  handoffs: string[];
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  effort?: 'none' | 'low' | 'medium' | 'high' | 'max';
  thinkingBudget?: number;
  includeThoughts?: boolean;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stop?: string[];
};

/** Agent detail (from GET /api/agents/:name) */
export type AgentDetail = {
  name: string;
  model: string;
  system: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  handoffs: Array<{ agent: string; description?: string; mode: 'oneway' | 'roundtrip' }>;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  effort?: 'none' | 'low' | 'medium' | 'high' | 'max';
  thinkingBudget?: number;
  includeThoughts?: boolean;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stop?: string[];
  timeout?: string;
  maxContext?: number;
  version?: string;
  mcp?: string[];
  mcpTools?: string[];
  hasGuardrails: boolean;
  guardrails: {
    hasInput: boolean;
    hasOutput: boolean;
    onBlock: string;
    maxRetries?: number;
  } | null;
};

/** Execution info */
export type ExecutionInfo = {
  executionId: string;
  workflow: string;
  status: 'running' | 'completed' | 'failed';
  steps: TraceEvent[];
  totalCost: number;
  startedAt: number;
  completedAt?: number;
  duration: number;
  result?: unknown;
  error?: string;
};

/** Trace event. Loose on the client — server types are the source of truth. */
export type TraceEvent = {
  executionId: string;
  workflow?: string;
  step: number;
  type: string;
  agent?: string;
  tool?: string;
  model?: string;
  promptVersion?: string;
  timestamp: number;
  duration?: number;
  cost?: number;
  tokens?: { input: number; output: number; reasoning?: number };
  data?: unknown;
  /** When set, this event was emitted from a nested child context (agent-as-tool).
   *  Value is the `callId` of the outer `tool_call` that spawned it. */
  parentToolCallId?: string;
};

/** Cost data */
export type CostData = {
  totalCost: number;
  totalTokens: { input: number; output: number; reasoning: number };
  byAgent: Record<string, { cost: number; calls: number }>;
  byModel: Record<
    string,
    { cost: number; calls: number; tokens: { input: number; output: number } }
  >;
  byWorkflow: Record<string, { cost: number; executions: number }>;
  /** Cost decomposition by retry reason. `primary` is first-attempt calls;
   *  `schema`/`validate`/`guardrail` are retry-attempt costs bucketed by
   *  which gate triggered the retry. Optional because a client may be talking
   *  to an older server that doesn't emit this field — consumers should
   *  tolerate absence via a `?? emptyRetry()` fallback. */
  retry?: {
    primary: number;
    primaryCalls: number;
    schema: number;
    schemaCalls: number;
    validate: number;
    validateCalls: number;
    guardrail: number;
    guardrailCalls: number;
    retryCalls: number;
  };
  /** Embedder cost from semantic memory ops (`ctx.remember({embed:true})`,
   *  `ctx.recall({query})`). Keyed by embedder model; `tokens` is a flat
   *  count (embeddings APIs don't split input/output). Optional for the
   *  same back-compat reason as `retry` — older servers won't emit it. */
  byEmbedder?: Record<string, { cost: number; calls: number; tokens: number }>;
};

/** Session summary */
export type SessionSummary = {
  id: string;
  messageCount: number;
};

/** Session detail */
export type SessionDetail = {
  id: string;
  history: ChatMessage[];
  handoffHistory?: HandoffRecord[];
};

/** Chat message */
export type ChatMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
};

/** Handoff record */
export type HandoffRecord = {
  source: string;
  target: string;
  mode: 'oneway' | 'roundtrip';
  timestamp: number;
  duration?: number;
};

/** Memory entry */
export type MemoryEntry = {
  key: string;
  value: unknown;
};

/** Pending decision */
export type PendingDecision = {
  executionId: string;
  channel: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

/** Registered eval summary */
export type RegisteredEval = {
  name: string;
  workflow: string;
  dataset: string;
  scorers: string[];
};

/** Eval history entry */
export type EvalHistoryEntry = {
  id: string;
  eval: string;
  timestamp: number;
  data: unknown;
};

/** Health check response */
export type HealthData = {
  status: string;
  readOnly: boolean;
  workflows: number;
  agents: number;
  tools: number;
};

/** Stream event (from WS) */
export type StreamEvent =
  | { type: 'token'; data: string }
  | { type: 'tool_call'; name: string; args: unknown; callId?: string }
  | { type: 'tool_result'; name: string; result: unknown; callId?: string }
  | { type: 'tool_approval'; name: string; args: unknown; approved: boolean; reason?: string }
  | { type: 'agent_start'; agent: string; model?: string }
  | { type: 'agent_end'; agent: string; cost?: number; duration?: number }
  | { type: 'handoff'; source: string; target: string; mode?: 'oneway' | 'roundtrip' }
  | { type: 'step'; step: number; data: TraceEvent }
  | { type: 'done'; data: unknown }
  | { type: 'error'; message: string };
