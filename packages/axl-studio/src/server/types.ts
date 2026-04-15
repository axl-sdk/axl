import type { AxlRuntime } from '@axlsdk/axl';

/** API success envelope */
export type ApiSuccess<T> = { ok: true; data: T };

/** API error envelope */
export type ApiError = { ok: false; error: { code: string; message: string } };

/** API response envelope */
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** Workflow summary for listing */
export type WorkflowSummary = {
  name: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

/** Tool summary for listing */
export type ToolSummary = {
  name: string;
  description: string;
  inputSchema: unknown;
  sensitive: boolean;
  requireApproval: boolean;
};

/** Agent summary for listing */
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

/** Cost aggregation data */
export type CostData = {
  totalCost: number;
  totalTokens: { input: number; output: number; reasoning: number };
  byAgent: Record<string, { cost: number; calls: number }>;
  byModel: Record<
    string,
    { cost: number; calls: number; tokens: { input: number; output: number } }
  >;
  byWorkflow: Record<string, { cost: number; executions: number }>;
  /**
   * Cost decomposition by retry reason. `primary` accumulates cost from
   * `agent_call` events WITHOUT a `retryReason` (first-attempt calls).
   * The other buckets accumulate cost from retry calls — the extra money
   * paid because a gate failed and the loop had to re-ask the LLM.
   *
   * Each bucket has a parallel `*Calls` counter so the UI can show exact
   * call counts alongside cost. `retryCalls` is the sum across all retry
   * reasons (not primary).
   */
  retry: {
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
  /**
   * Embedder cost from `ctx.remember({embed: true})` and semantic
   * `ctx.recall({query})`. Keyed by embedder model (e.g.
   * `text-embedding-3-small`), or `'unknown'` if the embedder didn't
   * report a model name. Tokens are a flat count because embedding
   * APIs don't differentiate input/output — it's just "tokens fed in".
   *
   * These costs are *also* counted in `totalCost` (embedder cost rides
   * the same top-level `event.cost` rail as agent cost), so the retry
   * and byAgent/byModel/byWorkflow buckets will always sum to ≤
   * totalCost; the difference is the embedder spend.
   */
  byEmbedder: Record<string, { cost: number; calls: number; tokens: number }>;
};

/** Session summary */
export type SessionSummary = {
  id: string;
  messageCount: number;
};

/** Memory entry */
export type MemoryEntry = {
  key: string;
  value: unknown;
};

/** Hono app environment bindings */
export type StudioEnv = {
  Variables: {
    runtime: AxlRuntime;
  };
};
