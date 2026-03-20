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
