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

/** Context passed to the verify function on retry (undefined on first call). */
export type VerifyRetry<T> = {
  /** Error message from the failed attempt (schema or validate). */
  error: string;
  /** Raw return value from the previous fn call. When fn() throws a ValidationError
   *  or VerifyError, falls back to err.lastOutput so the retry has data to repair. */
  output: unknown;
  /** Schema-parsed object — only present when schema passed but validate failed.
   *  Also populated from ValidationError.lastOutput when fn() throws (e.g., inner
   *  ctx.ask() exhausted its validate retries). Safe to modify and return. */
  parsed?: T;
};

/** Verify options */
export type VerifyOptions<T> = {
  retries?: number;
  fallback?: T;
  /** Post-schema business rule validation on the parsed object. */
  validate?: OutputValidator<T>;
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
  /** Post-schema business rule validation. Receives the parsed typed object after schema
   *  validation succeeds. Only runs when `schema` is set. Retries with accumulating context
   *  on failure (LLM sees all previous failed attempts). Throws `ValidationError` on exhaustion. */
  validate?: OutputValidator<T>;
  /** Maximum retries for validate failures (default: 2). */
  validateRetries?: number;
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
  /** Post-schema business rule validation. Passed through to the final `ctx.ask()` call. */
  validate?: OutputValidator<T>;
  /** Maximum retries for validate failures (default: 2). Passed through to the final `ctx.ask()` call. */
  validateRetries?: number;
};

/** Race options */
export type RaceOptions<T = unknown> = {
  /** Schema to validate each result. Invalid results are discarded and the race continues. */
  schema?: z.ZodType<T>;
  /** Post-schema business rule validation. Results that fail are discarded (same as schema failures). */
  validate?: OutputValidator<T>;
};

/** Execution status */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'waiting';

/** Trace event type. See `TraceEvent` for per-type data shapes. */
export type TraceEventType =
  | 'agent_call'
  | 'tool_call'
  | 'verify'
  | 'handoff'
  | 'delegate'
  | 'tool_denied'
  | 'tool_approval'
  | 'log'
  | 'workflow_start'
  | 'workflow_end'
  | 'guardrail'
  | 'schema_check'
  | 'validate';

/** Data shape for `agent_call` trace events. Populated on every LLM call (pass or fail). */
export type AgentCallTraceData = {
  /** Original user prompt passed to `ctx.ask()`. Does not include retry feedback or tool results. */
  prompt: string;
  /** Final LLM response content for this turn. */
  response: string;
  /** Resolved system prompt (after evaluating dynamic system selectors). */
  system?: string;
  /** Reasoning/thinking content returned by the provider, when available. */
  thinking?: string;
  /** Resolved model parameters sent to the provider for this call. */
  params?: {
    temperature?: number;
    maxTokens?: number;
    effort?: Effort;
    thinkingBudget?: number;
    includeThoughts?: boolean;
    toolChoice?: ToolChoice;
    stop?: string[];
  };
  /** 1-indexed iteration of the tool-calling loop for this `ctx.ask()` call. */
  turn?: number;
  /** When set, this call is a retry triggered by a failed gate check on the previous turn. */
  retryReason?: 'schema' | 'validate' | 'guardrail';
  /** Full ChatMessage[] sent to the provider this turn. Only populated when `trace.level === 'full'`. */
  messages?: ChatMessage[];
};

/** Data shape for `guardrail` trace events. */
export type GuardrailTraceData = {
  guardrailType: 'input' | 'output';
  blocked: boolean;
  reason?: string;
  /** 1-indexed attempt count (output guardrails only). */
  attempt?: number;
  /** Maximum attempts allowed before the guardrail throws. */
  maxAttempts?: number;
  /** The exact corrective message about to be injected into the conversation — only set when
   *  this check failed and a retry is happening. Gives users visibility into what the LLM sees
   *  between retry attempts. */
  feedbackMessage?: string;
};

/** Data shape for `schema_check` trace events. Emitted on every schema parse (pass or fail). */
export type SchemaCheckTraceData = {
  valid: boolean;
  reason?: string;
  attempt: number;
  maxAttempts: number;
  feedbackMessage?: string;
};

/** Data shape for `validate` trace events (post-schema business rule validation). */
export type ValidateTraceData = {
  valid: boolean;
  reason?: string;
  attempt: number;
  maxAttempts: number;
  feedbackMessage?: string;
};

/** Data shape for `tool_approval` trace events. Emitted by the approval gate on both outcomes. */
export type ToolApprovalTraceData = {
  approved: boolean;
  args: unknown;
  reason?: string;
};

/** Data shape for `tool_call` trace events. */
export type ToolCallTraceData = {
  args: unknown;
  result: unknown;
  callId?: string;
};

/** Data shape for `handoff` trace events. */
export type HandoffTraceData = {
  target: string;
  mode: 'oneway' | 'roundtrip';
  /** Wall-clock ms from handoff_to_X tool call to target agent completion.
   *  Always emitted — the event only fires at the terminal point of the
   *  handoff, so we always have a measurement. */
  duration: number;
  /** Source agent that initiated the handoff (mirrors the event's `agent` field
   *  for convenience — lets consumers query the handoff chain without
   *  stitching together event.agent and data.target). */
  source?: string;
  /** The `message` arg the source agent passed when invoking `handoff_to_X`
   *  (roundtrip mode only). Gives observability into *why* the source chose
   *  to delegate. Subject to `config.trace.redact`. */
  message?: string;
};

/** Data shape for `delegate` trace events. */
export type DelegateTraceData = {
  candidates: string[];
  /** Set when the decision is known at emission time (single-agent short-circuit). */
  selected?: string;
  /** Router model used for multi-agent routing. */
  routerModel?: string;
  /** Why this delegate was emitted: 'routed' (multi-agent) or 'single_candidate'. */
  reason: 'routed' | 'single_candidate';
};

/** Data shape for `verify` trace events. */
export type VerifyTraceData = {
  attempts: number;
  passed: boolean;
  lastError?: string;
};

/** Data shape for `workflow_start` trace events. Emitted once per workflow execution. */
export type WorkflowStartTraceData = {
  /** The validated input passed to the workflow handler. */
  input: unknown;
};

/** Data shape for `workflow_end` trace events. Emitted once per workflow execution
 *  on completion, failure, or cancellation. Distinguish cancellation via `aborted`. */
export type WorkflowEndTraceData = {
  status: 'completed' | 'failed';
  duration: number;
  /** Workflow return value. Present on `status: 'completed'`. */
  result?: unknown;
  /** Error message. Present on `status: 'failed'`. */
  error?: string;
  /** True when the failure was an `AbortError` (user cancellation, budget hard_stop,
   *  or consumer disconnect on streaming workflows). */
  aborted?: boolean;
};

/** Common fields carried by every `TraceEvent` regardless of `type`. */
type TraceEventBase = {
  executionId: string;
  step: number;
  timestamp: number;
  workflow?: string;
  agent?: string;
  promptVersion?: string;
  model?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
  duration?: number;
  /** When set, this event was emitted from a child context spawned by a tool
   *  handler. The value is the `callId` of the outer `tool_call` that invoked
   *  the tool. Lets consumers reconstruct agent-as-tool call graphs by
   *  joining nested events to their parent `tool_call`. Undefined on top-level
   *  events. */
  parentToolCallId?: string;
};

/**
 * Trace event. A discriminated union over `type` — consumers that narrow via
 * `type` get statically-typed access to `data` and event-specific fields.
 * When adding a new event type, extend this union AND the emitter in
 * `WorkflowContext.emitTrace()` together so the compiler catches drift.
 */
export type TraceEvent =
  | (TraceEventBase & { type: 'agent_call'; data?: AgentCallTraceData })
  | (TraceEventBase & { type: 'tool_call'; tool: string; data?: ToolCallTraceData })
  | (TraceEventBase & { type: 'tool_approval'; tool: string; data?: ToolApprovalTraceData })
  | (TraceEventBase & { type: 'tool_denied'; tool: string; data?: unknown })
  | (TraceEventBase & { type: 'guardrail'; data?: GuardrailTraceData })
  | (TraceEventBase & { type: 'schema_check'; data?: SchemaCheckTraceData })
  | (TraceEventBase & { type: 'validate'; data?: ValidateTraceData })
  | (TraceEventBase & { type: 'delegate'; data?: DelegateTraceData })
  | (TraceEventBase & { type: 'handoff'; data?: HandoffTraceData })
  | (TraceEventBase & { type: 'verify'; data?: VerifyTraceData })
  | (TraceEventBase & { type: 'log'; data?: unknown })
  | (TraceEventBase & { type: 'workflow_start'; data?: WorkflowStartTraceData })
  | (TraceEventBase & { type: 'workflow_end'; data?: WorkflowEndTraceData });

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

/** Result of a validate check (post-schema business rule validation).
 *  Note: uses `valid: true` = pass, unlike `GuardrailResult` which uses `block: true` = fail. */
export type ValidateResult = {
  valid: boolean;
  reason?: string;
};

/** Output validator function. Runs after schema parsing on the typed object.
 *  Only invoked when a schema is provided on the `ctx.ask()` call — without a schema,
 *  use output guardrails for raw text validation instead. */
export type OutputValidator<T = unknown> = (
  output: T,
  ctx: { metadata: Record<string, unknown> },
) => ValidateResult | Promise<ValidateResult>;

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
  result?: unknown;
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
  | { type: 'tool_call'; name: string; args: unknown; callId?: string }
  | { type: 'tool_result'; name: string; result: unknown; callId?: string }
  | { type: 'tool_approval'; name: string; args: unknown; approved: boolean; reason?: string }
  | { type: 'agent_start'; agent: string; model?: string }
  | { type: 'agent_end'; agent: string; cost?: number; duration?: number }
  | { type: 'handoff'; source: string; target: string; mode?: 'oneway' | 'roundtrip' }
  | { type: 'step'; step: number; data: unknown }
  | { type: 'done'; data: unknown }
  | { type: 'error'; message: string };

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
