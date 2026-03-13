import type { z } from 'zod';
import type { Effort, ToolChoice } from './providers/types.js';

/** Result type for concurrent operations (spawn, map) */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Budget execution result */
export type BudgetResult<T> = {
  value: T | null;
  budgetExceeded: boolean;
  totalCost: number;
};

/** Human decision from awaitHuman */
export type HumanDecision =
  | { approved: true; data?: string }
  | { approved: false; reason?: string };

/** Budget options */
export type BudgetOptions = {
  cost: string;
  onExceed?: 'finish_and_stop' | 'hard_stop' | 'warn';
};

/** Map options */
export type MapOptions = {
  concurrency?: number;
  quorum?: number;
};

/** Spawn options */
export type SpawnOptions = {
  quorum?: number;
};

/** Vote strategies */
export type VoteStrategy =
  | 'majority'
  | 'unanimous'
  | 'highest'
  | 'lowest'
  | 'mean'
  | 'median'
  | 'custom';

/** Vote options */
export type VoteOptions<T> = {
  strategy: VoteStrategy;
  key?: string;
  scorer?: (value: T) => number | Promise<number>;
  reducer?: (values: T[]) => T | Promise<T>;
};

/** Verify options */
export type VerifyOptions<T> = {
  retries?: number;
  fallback?: T;
};

/** AwaitHuman options */
export type AwaitHumanOptions = {
  channel: string;
  prompt: string;
  metadata?: Record<string, unknown>;
};

/** Ask options */
export type AskOptions<T = unknown> = {
  schema?: z.ZodType<T>;
  retries?: number;
  /** Per-call metadata passed to dynamic model/system selector functions. */
  metadata?: Record<string, unknown>;
  /** Override temperature for this call. */
  temperature?: number;
  /** Override max tokens for this call (default: 4096). */
  maxTokens?: number;
  /** How hard should the model try? Primary param for cost/quality tradeoff. */
  effort?: Effort;
  /** Precise thinking token budget (advanced). Overrides effort-based thinking allocation. */
  thinkingBudget?: number;
  /** Show reasoning summaries in responses. */
  includeThoughts?: boolean;
  /** Tool choice strategy for this call. */
  toolChoice?: ToolChoice;
  /** Stop sequences for this call. */
  stop?: string[];
  /** Provider-specific options merged into API requests. Not portable across providers. */
  providerOptions?: Record<string, unknown>;
};

/** Delegate options */
export type DelegateOptions<T = unknown> = {
  /** Zod schema for structured output from the selected agent. */
  schema?: z.ZodType<T>;
  /** Model URI for the internal router agent (default: first candidate's model). */
  routerModel?: string;
  /** Additional metadata passed to the router and selected agent. */
  metadata?: Record<string, unknown>;
  /** Number of retries for structured output validation (passed to the final ask). */
  retries?: number;
};

/** Race options */
export type RaceOptions<T = unknown> = {
  /** Schema to validate each result. Invalid results are discarded and the race continues. */
  schema?: z.ZodType<T>;
};

/** Execution status */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'waiting';

/** Trace event */
export type TraceEvent = {
  executionId: string;
  step: number;
  type:
    | 'agent_call'
    | 'tool_call'
    | 'verify'
    | 'handoff'
    | 'delegate'
    | 'tool_denied'
    | 'log'
    | 'workflow_start'
    | 'workflow_end'
    | 'guardrail';
  workflow?: string;
  agent?: string;
  tool?: string;
  promptVersion?: string;
  model?: string;
  cost?: number;
  duration?: number;
  data?: unknown;
  timestamp: number;
};

/** Result of a guardrail check. */
export type GuardrailResult = {
  block: boolean;
  reason?: string;
};

/** Input guardrail function. Runs before the LLM call. */
export type InputGuardrail = (
  prompt: string,
  ctx: { metadata: Record<string, unknown> },
) => GuardrailResult | Promise<GuardrailResult>;

/** Output guardrail function. Runs after the LLM response. */
export type OutputGuardrail = (
  response: string,
  ctx: { metadata: Record<string, unknown> },
) => GuardrailResult | Promise<GuardrailResult>;

/** Handler for when a guardrail blocks. */
export type GuardrailBlockHandler =
  | 'retry'
  | 'throw'
  | ((reason: string, ctx: { metadata: Record<string, unknown> }) => string | Promise<string>);

/** Full guardrails configuration for an agent. */
export type GuardrailsConfig = {
  input?: InputGuardrail;
  output?: OutputGuardrail;
  onBlock?: GuardrailBlockHandler;
  maxRetries?: number;
};

/** Execution info */
export type ExecutionInfo = {
  executionId: string;
  workflow: string;
  status: ExecutionStatus;
  steps: TraceEvent[];
  totalCost: number;
  startedAt: number;
  completedAt?: number;
  duration: number;
  error?: string;
};

/** Stream event types */
export type StreamEventType =
  | 'token'
  | 'tool_call'
  | 'tool_result'
  | 'tool_approval'
  | 'agent_start'
  | 'agent_end'
  | 'handoff'
  | 'step'
  | 'done'
  | 'error';

export type StreamEvent =
  | { type: 'token'; data: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; result: unknown }
  | { type: 'tool_approval'; name: string; args: unknown; approved: boolean; reason?: string }
  | { type: 'agent_start'; agent: string; model?: string }
  | { type: 'agent_end'; agent: string; cost?: number; duration?: number }
  | { type: 'handoff'; source: string; target: string; mode?: 'oneway' | 'roundtrip' }
  | { type: 'step'; step: number; data: unknown }
  | { type: 'done'; data: unknown }
  | { type: 'error'; error: Error };

/** Record of an agent handoff event (persisted in session metadata). */
export type HandoffRecord = {
  source: string;
  target: string;
  mode: 'oneway' | 'roundtrip';
  timestamp: number;
  duration?: number;
};

/** Information about a completed agent call, emitted via onAgentCallComplete. */
export type AgentCallInfo = {
  agent: string;
  prompt: string;
  response: string;
  model: string;
  cost: number;
  duration: number;
  promptVersion?: string;
  temperature?: number;
  maxTokens?: number;
  effort?: Effort;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  toolChoice?: ToolChoice;
  stop?: string[];
  /** Provider-specific options merged into API requests. Not portable across providers. */
  providerOptions?: Record<string, unknown>;
};

/** Chat message types for provider communication */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
  /** Provider-specific opaque metadata that must round-trip through conversation history. */
  providerMetadata?: Record<string, unknown>;
};

export type ToolCallMessage = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

/** Provider response */
export type ProviderResponse = {
  content: string;
  thinking_content?: string;
  tool_calls?: ToolCallMessage[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
  };
  cost?: number;
  /** Provider-specific opaque metadata that needs to round-trip through conversation history. */
  providerMetadata?: Record<string, unknown>;
};
