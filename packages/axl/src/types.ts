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

/**
 * Canonical list of `AxlEvent.type` discriminators. Single source of truth —
 * derive `AxlEventType` from this tuple and use it to validate stream filters,
 * redaction tables, and exhaustiveness assertions.
 */
export const AXL_EVENT_TYPES = [
  // Workflow lifecycle
  'workflow_start',
  'workflow_end',
  // Ask boundary
  'ask_start',
  'ask_end',
  // Agent turn lifecycle
  'agent_call_start',
  'agent_call_end',
  // Content delivery (stream-only)
  'token',
  // Tool invocation lifecycle
  'tool_call_start',
  'tool_call_end',
  // Single-point tool events
  'tool_approval',
  'tool_denied',
  // Delegation
  'delegate',
  // Handoff (spans two asks; not AskScoped)
  'handoff',
  // Pipeline (retry/validation lifecycle) — added in PR 2; reserved here.
  'pipeline',
  // Progressive structured output — added in PR 2; reserved here.
  'partial_object',
  // Verification
  'verify',
  // Observability
  'log',
  'memory_remember',
  'memory_recall',
  'memory_forget',
  // Legacy gate events — emitted by current code; collapsed into `pipeline`
  // in PR 2 (spec/16-streaming-wire-reliability §4.2).
  'guardrail',
  'schema_check',
  'validate',
  // Terminal workflow markers
  'done',
  'error',
] as const;

/** Discriminator union derived from `AXL_EVENT_TYPES`. */
export type AxlEventType = (typeof AXL_EVENT_TYPES)[number];

/** Data shape for `agent_call_end` events. Populated on every LLM call (pass or fail). */
export type AgentCallData = {
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

/** Data shape for `tool_call_end` events. */
export type ToolCallData = {
  args: unknown;
  result: unknown;
  callId?: string;
};

/** Data shape for `tool_call_start` events. */
export type ToolCallStartData = {
  args: unknown;
};

/** Data shape for `tool_approval` events. Emitted by the approval gate on both outcomes. */
export type ToolApprovalData = {
  approved: boolean;
  args: unknown;
  reason?: string;
};

/** Data shape for `tool_denied` events. Emitted when the LLM names a tool the agent doesn't expose. */
export type ToolDeniedData = {
  args?: unknown;
  reason?: string;
  callId?: string;
};

/** Data shape for `handoff` events. */
export type HandoffData = {
  source: string;
  target: string;
  mode: 'oneway' | 'roundtrip';
  /** Wall-clock ms from handoff_to_X tool call to target agent completion.
   *  Always emitted — the event only fires at the terminal point of the
   *  handoff, so we always have a measurement. */
  duration: number;
  /** The `message` arg the source agent passed when invoking `handoff_to_X`
   *  (roundtrip mode only). Subject to `config.trace.redact`. */
  message?: string;
};

/** Data shape for `delegate` events. */
export type DelegateData = {
  candidates: string[];
  /** Set when the decision is known at emission time (single-agent short-circuit). */
  selected?: string;
  /** Router model used for multi-agent routing. */
  routerModel?: string;
  /** Why this delegate was emitted: 'routed' (multi-agent) or 'single_candidate'. */
  reason: 'routed' | 'single_candidate';
};

/** Data shape for `verify` events. */
export type VerifyData = {
  attempts: number;
  passed: boolean;
  lastError?: string;
};

/** Data shape for legacy `guardrail` events. Replaced by `pipeline` in PR 2. */
export type GuardrailData = {
  guardrailType: 'input' | 'output';
  blocked: boolean;
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  feedbackMessage?: string;
};

/** Data shape for legacy `schema_check` events. Replaced by `pipeline` in PR 2. */
export type SchemaCheckData = {
  valid: boolean;
  reason?: string;
  attempt: number;
  maxAttempts: number;
  feedbackMessage?: string;
};

/** Data shape for legacy `validate` events. Replaced by `pipeline` in PR 2. */
export type ValidateData = {
  valid: boolean;
  reason?: string;
  attempt: number;
  maxAttempts: number;
  feedbackMessage?: string;
};

/** Data shape for `workflow_start` events. Emitted once per workflow execution. */
export type WorkflowStartData = {
  /** The validated input passed to the workflow handler. */
  input: unknown;
};

/** Data shape for `workflow_end` events. Emitted once per workflow execution
 *  on completion, failure, or cancellation. Distinguish cancellation via `aborted`. */
export type WorkflowEndData = {
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

/** Data shape for `memory_remember` / `memory_recall` / `memory_forget` events. */
export type MemoryEventData = {
  scope: string;
  key?: string;
  /** Result count for `recall` (number of vectors returned). */
  count?: number;
  /** Embedder cost for semantic recall/remember. Mirrored at the top-level
   *  `cost` on the event so cost rails (`trackExecution`) pick it up. */
  cost?: number;
  /** Embedder usage detail (tokens / model). */
  usage?: { tokens?: number; cost?: number; model?: string };
  /** True when this memory op called the semantic recall path (vs. key-only). */
  embed?: boolean;
  /** True when a key-only recall returned a value / semantic call path. */
  semantic?: boolean;
  /** True when a key-only recall returned a value. */
  hit?: boolean;
  /** Result count for `recall` (alias for `count` retained for back-compat). */
  resultCount?: number;
  /** Error message when the operation failed on the partial-failure path. */
  error?: string;
};

/** Common fields carried by every `AxlEvent` regardless of `type`. */
export type AxlEventBase = {
  executionId: string;
  /** Monotonic per-execution step counter, shared across nested asks via ALS. */
  step: number;
  /** Wall-clock ms. */
  timestamp: number;
  /** Workflow this event belongs to. Auto-stamped by `emitEvent` from
   *  `this.workflowName` when defined; callers may override. */
  workflow?: string;
  /** Optional emitting-agent name. Variants that always have an agent
   *  (e.g., `agent_call_start/end`) redeclare it as required so consumers
   *  narrowing on those variants get a non-optional `agent`. Single-point
   *  events that may or may not have an agent (`handoff`, gate events,
   *  `log`) keep the optional. */
  agent?: string;
  /** Optional model URI — set on agent-related events; ignored on others. */
  model?: string;
  /** Optional prompt version stamped from `agent._config.version`. */
  promptVersion?: string;
  /**
   * Cost (USD) contributed by this event.
   *
   * Two DIFFERENT semantics ship on this field and consumers must know
   * which they're reading:
   *
   *   - **Leaf cost** (`agent_call_end`, `tool_call_end`, `memory_remember`,
   *     `memory_recall`): the authoritative charge for this single
   *     provider call / tool invocation / embedder call. Summing these
   *     across an execution gives the true spend.
   *
   *   - **Per-ask rollup** (`ask_end`): the SUM of leaf costs emitted
   *     within this ask's frame, EXCLUDING nested asks (which roll up
   *     into their own `ask_end`). Spec/16 decision 10.
   *
   * **If you write your own accumulator, DO NOT do `total += event.cost`
   * across all event types — you'll double-count every ask** because the
   * leaves AND the rollup both carry `cost`. Use the exported
   * `eventCostContribution(event)` helper from `@axlsdk/axl` instead:
   * it encapsulates the "skip ask_end, finite-check, leaf-only" rule in
   * one place so your accumulator stays in lockstep with the built-in
   * `runtime.trackExecution`, `ExecutionInfo.totalCost`, and Studio's
   * cost aggregator.
   *
   * Other variants may stamp `cost` optionally to flow into cost rails
   * (e.g., memory ops mirror `usage.cost` here). Review UX-8.
   */
  cost?: number;
  /** Token counts. Required-by-narrowing on `agent_call_end`; optional on
   *  any event that wishes to mirror an aggregate. Scope is agent prompt /
   *  completion / reasoning tokens ONLY — embedder tokens live in
   *  `memory_*.data.usage.tokens` and are deliberately NOT summed into
   *  this field (different pricing, different model, different category). */
  tokens?: { input?: number; output?: number; reasoning?: number };
  /** Duration in ms (set on `_end` variants and a few single-point events). */
  duration?: number;
  /**
   * @deprecated Use `parentAskId` (on `AskScoped`) for ask-graph correlation
   *  going forward. Retained for one minor cycle so existing telemetry
   *  consumers that grep agent-as-tool call graphs by tool callId keep
   *  working — `WorkflowContext.createChildContext()` still populates this
   *  during PR 1, so reading it is safe through this transition window.
   *  Removal is tracked in the follow-up to spec/16-streaming-wire-reliability.
   */
  parentToolCallId?: string;
};

/** Fields on every event that originates within a specific `ctx.ask()` call. */
export type AskScoped = {
  askId: string;
  /** Absent on root ask. */
  parentAskId?: string;
  /** 0 = root ask; +1 per nested ask. */
  depth: number;
  /** Emitting agent's name. Absent on `ask_start` (pre-resolution) and on
   *  events that predate agent resolution. */
  agent?: string;
};

/** Meta carried alongside callback invocations so consumers can group/route by ask. */
export type CallbackMeta = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent: string;
};

/**
 * Unified event union. Replaces the old `TraceEvent` (rich, persisted) and
 * `StreamEvent` (lean, wire) by emitting a single rich event from one site
 * and consuming the same shape on both rails.
 *
 * - Streaming consumers iterate `AxlStream` (an `AsyncIterable<AxlEvent>`).
 * - Non-streaming consumers read `ExecutionInfo.events: AxlEvent[]`.
 *
 * Tree reconstruction: group ask-scoped events by `askId`, parent-link via
 * `parentAskId`, sort by `step`, render by `depth`. Tokens (high-volume) and
 * `partial_object` events are stream-only — never persisted to
 * `ExecutionInfo.events`.
 *
 * When adding a new variant, extend `AXL_EVENT_TYPES` AND the emitter in
 * `WorkflowContext.emitEvent()` together so the compiler catches drift; the
 * exhaustiveness fixture in `__tests__/axl-event-exhaustive.test-d.ts` will
 * also fail until the new case is handled.
 */
export type AxlEvent =
  // ── Execution lifecycle ─────────────────────────────────────────────────
  | (AxlEventBase & { type: 'workflow_start'; workflow: string; data: WorkflowStartData })
  | (AxlEventBase & { type: 'workflow_end'; workflow: string; data: WorkflowEndData })

  // ── Ask boundary (user-level ctx.ask() call) ────────────────────────────
  | (AxlEventBase & AskScoped & { type: 'ask_start'; prompt: string })
  | (AxlEventBase &
      AskScoped & {
        type: 'ask_end';
        /** Discriminated outcome — narrow on `outcome.ok`. Ask-internal throws
         *  surface here, NOT via the workflow-level `error` event. */
        outcome: { ok: true; result: unknown } | { ok: false; error: string };
        /** Sum of `agent_call_end.cost` + `tool_call_end.cost` WITHIN THIS ASK,
         *  excluding nested asks. Nested asks contribute to their own ask_end. */
        cost: number;
        duration: number;
      })

  // ── Agent turn lifecycle (one LLM call within an ask) ───────────────────
  | (AxlEventBase &
      AskScoped & {
        type: 'agent_call_start';
        agent: string;
        model: string;
        /** 1-indexed tool-calling loop iteration within the ask. */
        turn: number;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'agent_call_end';
        agent: string;
        model: string;
        /** Authoritative turn-level cost. */
        cost: number;
        duration: number;
        tokens?: { input?: number; output?: number; reasoning?: number };
        data: AgentCallData;
      })

  // ── Content delivery (stream-only; never in ExecutionInfo.events) ───────
  | (AxlEventBase & AskScoped & { type: 'token'; data: string })

  // ── Tool invocation lifecycle ───────────────────────────────────────────
  | (AxlEventBase &
      AskScoped & {
        type: 'tool_call_start';
        tool: string;
        callId: string;
        data: ToolCallStartData;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'tool_call_end';
        tool: string;
        callId: string;
        duration: number;
        cost?: number;
        data: ToolCallData;
      })

  // ── Single-point tool events ────────────────────────────────────────────
  | (AxlEventBase &
      AskScoped & {
        type: 'tool_approval';
        tool: string;
        callId?: string;
        data: ToolApprovalData;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'tool_denied';
        tool: string;
        callId?: string;
        data?: ToolDeniedData;
      })

  // ── Delegation ──────────────────────────────────────────────────────────
  | (AxlEventBase & AskScoped & { type: 'delegate'; data: DelegateData })

  // ── Handoff (atomic; spans two asks — NOT AskScoped) ────────────────────
  | (AxlEventBase & {
      type: 'handoff';
      fromAskId: string;
      toAskId: string;
      sourceDepth: number;
      targetDepth: number;
      data: HandoffData;
    })

  // ── Pipeline (retry/validation lifecycle; multi-state via `status`) ─────
  | (AxlEventBase &
      AskScoped & {
        type: 'pipeline';
        status: 'start';
        stage: 'initial' | 'schema' | 'validate' | 'guardrail';
        attempt: number;
        maxAttempts: number;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'pipeline';
        status: 'failed';
        stage: 'schema' | 'validate' | 'guardrail';
        attempt: number;
        maxAttempts: number;
        /** Feedback message about to be injected into the conversation. */
        reason: string;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'pipeline';
        status: 'committed';
        /** The final successful attempt. */
        attempt: number;
        maxAttempts: number;
      })

  // ── Progressive structured output ───────────────────────────────────────
  | (AxlEventBase &
      AskScoped & {
        type: 'partial_object';
        attempt: number;
        /** DeepPartial<T>; consumers cast at the render site. */
        data: { object: unknown };
      })

  // ── Verification ────────────────────────────────────────────────────────
  | (AxlEventBase & AskScoped & { type: 'verify'; data: VerifyData })

  // ── Legacy gate events (collapsed into `pipeline` in PR 2) ──────────────
  | (AxlEventBase & Partial<AskScoped> & { type: 'guardrail'; data?: GuardrailData })
  | (AxlEventBase & Partial<AskScoped> & { type: 'schema_check'; data?: SchemaCheckData })
  | (AxlEventBase & Partial<AskScoped> & { type: 'validate'; data?: ValidateData })

  // ── Observability ───────────────────────────────────────────────────────
  | (AxlEventBase & Partial<AskScoped> & { type: 'log'; data: unknown })
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'memory_remember' | 'memory_recall' | 'memory_forget';
        data: MemoryEventData;
      })

  // ── Terminal workflow markers (idiomatic names; see decision 9) ─────────
  | (AxlEventBase & { type: 'done'; data: { result: unknown } })
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'error';
        data: { message: string; name?: string; code?: string };
      });

/** Convenience: extract the union member matching a given `type` discriminator. */
export type AxlEventOf<T extends AxlEventType> = Extract<AxlEvent, { type: T }>;

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
  /** Full event timeline. Tokens and `partial_object` events are NOT persisted
   *  here (stream-only); aggregate `tokens: { input, output, reasoning? }`
   *  on `agent_call_end` is the persisted token representation. */
  events: AxlEvent[];
  totalCost: number;
  startedAt: number;
  completedAt?: number;
  duration: number;
  result?: unknown;
  error?: string;
};

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
