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
  events: AxlEvent[];
  totalCost: number;
  startedAt: number;
  completedAt?: number;
  duration: number;
  result?: unknown;
  error?: string;
};

/** Axl event. Loose on the client — server types are the source of truth.
 *  Replaces the legacy `TraceEvent` + `StreamEvent` split; see
 *  `@axlsdk/axl#AxlEvent` for the strict discriminated union. */
export type AxlEvent = {
  executionId: string;
  workflow?: string;
  step: number;
  type: string;
  agent?: string;
  tool?: string;
  callId?: string;
  model?: string;
  promptVersion?: string;
  timestamp: number;
  duration?: number;
  cost?: number;
  tokens?: { input: number; output: number; reasoning?: number };
  data?: unknown;
  /** Ask correlation (spec/16 §2.1). Present on every ask-scoped variant
   *  — group by `askId`, link parents via `parentAskId`, indent by
   *  `depth` (0 = root ask; +1 per nested ctx.ask()). Absent on
   *  workflow lifecycle / error / done events and on `handoff` (which
   *  spans two asks via `fromAskId` / `toAskId` instead). */
  askId?: string;
  parentAskId?: string;
  depth?: number;
  /** Discriminated outcome on `ask_end` events. */
  outcome?: { ok: true; result: unknown } | { ok: false; error: string };
  /** `pipeline` event status (spec/16 §4.2). */
  status?: 'start' | 'failed' | 'committed';
  /** `pipeline` event stage. */
  stage?: 'initial' | 'schema' | 'validate' | 'guardrail';
  /** `pipeline` / `partial_object` attempt counter. */
  attempt?: number;
  maxAttempts?: number;
  /** `pipeline(failed).reason`: feedback message about to be injected. */
  reason?: string;
  /** `ask_start.prompt`. */
  prompt?: string;
  /** `handoff` correlation: from/to askIds and their depths. */
  fromAskId?: string;
  toAskId?: string;
  sourceDepth?: number;
  targetDepth?: number;
  /**
   * @deprecated Use `parentAskId` for ask-graph correlation. Kept one
   * minor cycle for telemetry consumers that still grep agent-as-tool
   * call graphs by tool callId.
   */
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

/** Time window for aggregate views */
export type WindowId = '24h' | '7d' | '30d' | 'all';

/** Aggregate broadcast payload from WS */
export type AggregateBroadcast<T> = {
  snapshots: Record<WindowId, T>;
  updatedAt: number;
};

/** Eval trend data from GET /api/eval-trends */
export type EvalTrendData = {
  byEval: Record<
    string,
    {
      runs: Array<{
        timestamp: number;
        id: string;
        scores: Record<string, number>;
        cost: number;
        /** Primary model (first of `metadata.models`). Undefined for legacy runs. */
        model?: string;
        /** Total run duration in ms. */
        duration?: number;
      }>;
      latestScores: Record<string, number>;
      scoreMean: Record<string, number>;
      scoreStd: Record<string, number>;
      costTotal: number;
      runCount: number;
    }
  >;
  totalRuns: number;
  totalCost: number;
};

/** Workflow stats from GET /api/workflow-stats */
export type WorkflowStatsResponse = {
  byWorkflow: Record<
    string,
    {
      total: number;
      completed: number;
      failed: number;
      durationP50: number;
      durationP95: number;
      avgDuration: number;
    }
  >;
  totalExecutions: number;
  failureRate: number;
};

/** Trace stats from GET /api/trace-stats */
export type TraceStatsData = {
  eventTypeCounts: Record<string, number>;
  byTool: Record<string, { calls: number; denied: number; approved: number }>;
  retryByAgent: Record<string, { schema: number; validate: number; guardrail: number }>;
  totalEvents: number;
};

/** Health check response */
export type HealthData = {
  status: string;
  readOnly: boolean;
  workflows: number;
  agents: number;
  tools: number;
};

/** Stream event (from WS).
 *
 *  TODO(PR-3-spec-16): The runtime currently translates `AxlEvent` into this
 *  legacy wire shape (`runtime.ts` adapter). PR 3 collapses the wire format to
 *  `AxlEvent` directly, at which point this type — and the `tool_call`/
 *  `tool_result`/`agent_start`/`agent_end`/`step` variants in particular —
 *  should be removed in favor of `AxlEvent`.
 */
export type StreamEvent =
  | { type: 'token'; data: string }
  | { type: 'tool_call'; name: string; args: unknown; callId?: string }
  | { type: 'tool_result'; name: string; result: unknown; callId?: string }
  | { type: 'tool_approval'; name: string; args: unknown; approved: boolean; reason?: string }
  | { type: 'agent_start'; agent: string; model?: string }
  | { type: 'agent_end'; agent: string; cost?: number; duration?: number }
  | { type: 'handoff'; source: string; target: string; mode?: 'oneway' | 'roundtrip' }
  | { type: 'step'; step: number; data: AxlEvent }
  | { type: 'done'; data: unknown }
  | { type: 'error'; message: string };
