import type { z } from 'zod';
import type { Effort, ToolChoice } from './providers/types.js';

/** Result type for concurrent operations (spawn, map) */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Budget execution result */
export type BudgetResult<T> = {
  value: T | null;
  budgetExceeded: boolean;
  totalCost: number;
  /**
   * True when the block ran a model with no usable cost (unpriced / pricing-table
   * miss) that did measurable work. `totalCost` is then a LOWER BOUND — the unknown
   * component is omitted. NOTE: this is observability only; cost limits / `hard_stop`
   * are NOT enforced on unpriced spend (the enforcement rail never sees it). Token
   * budgets are the future fix for governing unpriced models.
   */
  unpriced: boolean;
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

/**
 * Controls how the output `schema` is rendered into the MODEL-FACING prompt
 * (spec 22, Problem B). Independent of the `.parse` gate — whichever mode you
 * pick, the full Zod `schema` still validates the reply.
 *
 *  - `'json-schema'` (default) — append the compact, `$ref`-hoisted JSON-Schema
 *    guidance (`Respond with valid JSON matching this schema: …`).
 *  - `'none'` — append NOTHING; the schema is the parse gate only. Fires a
 *    `schema_prompt_none_no_guidance` diagnostic (the model gets zero shape hint).
 *  - `{ render }` — append exactly this string, or the string your function
 *    returns from the schema. Object form (not a bare string) so custom text can
 *    never collide with the `'none'` / `'json-schema'` sentinels.
 */
export type SchemaPromptOption =
  | 'json-schema'
  | 'none'
  | { render: string | ((schema: z.ZodType<unknown>) => string) };

/** Ask options */
export type AskOptions<T = unknown> = {
  schema?: z.ZodType<T>;
  /** How the `schema` is rendered into the model-facing prompt. Default
   *  `'json-schema'`. Does not affect the `.parse` gate. See `SchemaPromptOption`. */
  schemaPrompt?: SchemaPromptOption;
  /** Opt into the provider's NATIVE structured-output path (`json_schema`),
   *  deriving the provider schema from `schema` (no second, contradictable
   *  schema). Providers that can't honor it downgrade/ignore it and a
   *  `schema_diagnostic` warns; the call still proceeds. Only takes effect when
   *  a `schema` is set and no tools are registered. Default `false`. */
  nativeStructuredOutput?: boolean;
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
  /** How the `schema` is rendered into the selected agent's prompt. Forwarded to
   *  the terminal `ctx.ask()`. See `SchemaPromptOption`. */
  schemaPrompt?: SchemaPromptOption;
  /** Opt the terminal `ctx.ask()` into the provider's native structured-output
   *  path. Forwarded to the selected agent's ask. */
  nativeStructuredOutput?: boolean;
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
  'tool_call_rejected',
  // Single-point tool events
  'tool_approval',
  // Delegation
  'delegate',
  // Handoff (spans two asks; not AskScoped).
  // `handoff_start` emits before the target ask begins; always fired.
  // `handoff_return` emits when control returns to source; roundtrip only
  // (oneway handoffs have no return trip — the target's `ask_end` IS the
  // end of the chain).
  'handoff_start',
  'handoff_return',
  // Pipeline (retry/validation lifecycle) — added in PR 2; reserved here.
  'pipeline',
  // Progressive structured output — added in PR 2; reserved here.
  'partial_object',
  // Character-level deltas inside string values of progressive structured
  // output. Same gating as `partial_object` (schema set, no tools, root is
  // ZodObject); fires per text-delta chunk when the walker is inside a
  // string value at a known JSON Pointer path. Designed for chat-style
  // typewriter rendering of long string fields.
  'string_delta',
  // Verification
  'verify',
  // Schema capability diagnostics (spec 22, Problem E) — surface the silent
  // structured-output cliffs (oversized appended schema, dropped refinements,
  // streaming disabled, zero-guidance `schemaPrompt:'none'`).
  'schema_diagnostic',
  // Observability
  'log',
  'memory_remember',
  'memory_recall',
  'memory_forget',
  // Scoped execution checkpoints (`ctx.checkpoint`)
  'checkpoint_save',
  'checkpoint_replay',
  // Human-in-the-loop (`ctx.awaitHuman`)
  'await_human',
  'await_human_resolved',
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

/** Backward-compatible name for the canonical v2 writer discriminator list. */
export const AXL_EVENT_TYPES_V2 = AXL_EVENT_TYPES;

/** Accepted/rejected tool lifecycle discriminators in event schema v2. */
export const AXL_TOOL_LIFECYCLE_TYPES_V2 = [
  'tool_call_start',
  'tool_call_end',
  'tool_call_rejected',
] as const;

/** Resolved model parameters sent to the provider for an LLM call. */
export type AgentCallParams = {
  temperature?: number;
  maxTokens?: number;
  effort?: Effort;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  toolChoice?: ToolChoice;
  stop?: string[];
};

/**
 * Data shape for `agent_call_start` events — the **request** side of the call.
 * Everything here is known at the moment the call is dispatched, before the
 * provider responds. Consumers can render "what's being asked" without waiting
 * for completion.
 */
export type AgentCallStartData = {
  /** Original user prompt passed to `ctx.ask()`. Does not include retry feedback or tool results. */
  prompt: string;
  /** Resolved system prompt (after evaluating dynamic system selectors). */
  system?: string;
  /** Resolved model parameters sent to the provider for this call. */
  params?: AgentCallParams;
  /** 1-indexed iteration of the tool-calling loop for this `ctx.ask()` call. */
  turn: number;
  /** When set, this call is a retry triggered by a failed gate check on the previous turn. */
  retryReason?: 'schema' | 'validate' | 'guardrail';
  /** Names of tools exposed to the model on this call. Empty/omitted when no tools are bound. */
  toolNames?: string[];
  /** Full ChatMessage[] sent to the provider this turn. Only populated when `trace.level === 'full'`. */
  messages?: ChatMessage[];
};

/**
 * Data shape for `agent_call_end` events — the **response** side of the call.
 * Populated when the provider returns (success or recoverable failure). The
 * companion request-side payload lives on the matching `agent_call_start`.
 *
 * Pair invariant: every `agent_call_start` is followed by exactly one
 * `agent_call_end`, even on provider error. On the error path `response` is
 * empty and `error` carries the provider's message; cost/tokens/duration are
 * still emitted (top-level on the event) when partial usage is available.
 */
export type AgentCallEndData = {
  /** Final LLM response content for this turn. Empty string on error. */
  response: string;
  /** Reasoning/thinking content returned by the provider, when available. */
  thinking?: string;
  /** 1-indexed iteration of the tool-calling loop. Mirrors the matching `agent_call_start.data.turn`. */
  turn: number;
  /** Mirrors `agent_call_start.data.retryReason` so cost-attribution consumers
   *  reading `agent_call_end` (cost lives here) can bucket without joining. */
  retryReason?: 'schema' | 'validate' | 'guardrail';
  /** Provider error message when the call threw (network failure, 4xx/5xx,
   *  abort, etc). Mutually exclusive with `response` content. Subject to
   *  `config.trace.redact` (vendor errors can echo prompt text). */
  error?: string;
  /** HTTP status when the thrown error was a `ProviderError` (`0` for network
   *  failures). Omitted for non-provider errors. The raw error body is
   *  intentionally NOT placed on the event (it's redaction-eligible). */
  status?: number;
  /** Semantic failover hint from a thrown `ProviderError` (see
   *  `ProviderError.retryable`). Omitted for non-provider errors. */
  retryable?: boolean;
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

/** Data shape for a v2 tool start. The event's `tool` is canonical; this field
 * retains the provider-visible request name only when it differs. */
export type ToolCallStartDataV2 = {
  args: unknown;
  requestedTool?: string;
};

/** Data shape for `tool_approval` events. Emitted by the approval gate on both outcomes. */
export type ToolApprovalData = {
  approved: boolean;
  args: unknown;
  reason?: string;
};

/** Historical v1 data shape for `tool_denied` events. V2 writers emit
 * `tool_call_rejected` for unavailable provider requests instead. */
export type ToolDeniedData = {
  args?: unknown;
  reason?: string;
  callId?: string;
};

/** A validation issue for a provider-issued tool invocation.
 *
 * Values are deliberately omitted: paths and validator codes are sufficient
 * for correction without copying application data into diagnostic channels.
 */
export type ToolArgumentIssue = {
  path: readonly (string | number)[];
  code: string;
  message?: string;
};

/** Data shape for a v2 tool request rejected before execution starts. */
export type ToolCallRejectedData =
  | {
      reason: 'unavailable';
      requestedTool: string;
      availableTools: string[];
    }
  | {
      reason: 'invalid_json';
      requestedTool: string;
      message: string;
    }
  | {
      reason: 'invalid_arguments';
      requestedTool: string;
      args: unknown;
      issues: readonly ToolArgumentIssue[];
    };

/** Host-observable error details for a terminal tool outcome. */
export type ToolEventError = {
  name: string;
  message: string;
  code?: string;
  /** Optional host-only diagnostic cause. Redaction removes this at every
   * untrusted observation boundary. */
  cause?: unknown;
};

/** Constructor input for the next-major model-safe thrown tool failure. */
export type ToolFailureOptions = {
  message: string;
  modelMessage: string;
  code?: string;
  cause?: unknown;
};

/** Failure details for an accepted v2 tool invocation. */
export type ToolCallFailure =
  | {
      phase: 'approval';
      kind: 'infrastructure';
      disposition: 'abort';
      error: ToolEventError;
    }
  | {
      phase: 'before_hook';
      kind: 'tool_failure';
      disposition: 'continue';
      error: ToolEventError;
    }
  | {
      phase: 'before_hook';
      kind: 'unexpected';
      disposition: 'abort';
      error: ToolEventError;
    }
  | {
      phase: 'handler';
      kind: 'tool_failure' | 'mcp_error';
      disposition: 'continue';
      error: ToolEventError;
      attempts: number;
    }
  | {
      phase: 'handler';
      kind: 'unexpected';
      disposition: 'abort';
      error: ToolEventError;
      attempts: number;
    }
  | {
      phase: 'after_hook';
      kind: 'tool_failure';
      disposition: 'continue';
      error: ToolEventError;
      result: unknown;
    }
  | {
      phase: 'after_hook';
      kind: 'unexpected';
      disposition: 'abort';
      error: ToolEventError;
      result: unknown;
    }
  | {
      phase: 'projection' | 'serialization';
      kind: 'output';
      disposition: 'abort';
      error: ToolEventError;
      result: unknown;
    };

/** Cancellation details for an accepted v2 tool invocation. */
export type ToolCallCancellation =
  | {
      phase: 'approval' | 'before_hook' | 'handler';
      reason?: string;
    }
  | {
      phase: 'after_handler' | 'after_hook' | 'projection' | 'serialization';
      result: unknown;
      reason?: string;
    };

/** Terminal state of an accepted v2 tool invocation. */
export type ToolCallOutcome =
  | { status: 'succeeded'; result: unknown }
  | { status: 'failed'; failure: ToolCallFailure }
  | { status: 'denied'; reason?: string }
  | { status: 'cancelled'; cancellation: ToolCallCancellation };

/** Data shape for a v2 `tool_call_end` event. */
export type ToolCallEndData = {
  args: unknown;
  requestedTool?: string;
  outcome: ToolCallOutcome;
};

/** Data shape for `handoff_start` events (always emitted, pre-transition). */
export type HandoffStartData = {
  source: string;
  target: string;
  mode: 'oneway' | 'roundtrip';
  /** The `message` arg the source agent passed when invoking `handoff_to_X`
   *  (roundtrip mode only). Subject to `config.trace.redact`. */
  message?: string;
};

/** Data shape for `handoff_return` events (roundtrip-only, post-return).
 *  The returned value itself is observable via the target ask's
 *  `ask_end.outcome`; this event marks the control transfer back to the
 *  source agent and carries the round-trip duration. */
export type HandoffReturnData = {
  source: string;
  target: string;
  /** Wall-clock ms from `handoff_start` emission to control returning. */
  duration: number;
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

/**
 * Data shape for `string_delta` events.
 *
 * Emitted while the streaming walker is inside a string VALUE (not a key)
 * during a schema-mode response. Each event carries the unescaped chars
 * appended within a single text-delta chunk for one path; consumers
 * concatenate `delta` per (`askId`, `path`) to reconstruct the running text.
 *
 * Splitting an escape sequence across chunks is supported — the walker
 * holds escape state across chunks, so a `\\u00` in chunk N and `41` in
 * chunk N+1 produces a single `A` in the chunk-N+1 delta.
 */
export type StringDeltaData = {
  /**
   * RFC 6901 JSON Pointer to the string value. Examples:
   *   - `/summary` (root-level field)
   *   - `/sources/0/title` (nested through array)
   *   - keys containing `~` or `/` are escaped to `~0`/`~1` per RFC.
   *
   * Path is structural metadata (preserved under `trace.redact`).
   */
  path: string;
  /**
   * Unescaped characters appended this chunk. JSON escapes are translated:
   * `\\n` → "\n", `\\t` → "\t", `\\"` → '"', `\\\\` → "\\", `\\uXXXX` → the
   * corresponding UTF-16 code unit. Surrogate pairs (e.g. `\\uD83D\\uDE00`)
   * are emitted as two code units in the order they parse — matches what
   * `JSON.parse` produces.
   *
   * Subject to `config.trace.redact` (always scrubbed when redaction is on).
   */
  delta: string;
};

/**
 * Data for the `schema_diagnostic` event (spec 22, Problem E) — a `kind`-
 * discriminated payload mirroring `pipeline`'s two-level union. Each variant
 * surfaces one silent structured-output cliff:
 *
 *  - `prompt_schema_oversized` — an appended prompt schema (or a tool-def
 *    schema) exceeds the token threshold; the schema is a recurring input cost.
 *  - `dropped_refinements` — the schema carries `.refine()`/`.superRefine()`
 *    rules `z.toJSONSchema` drops, so the model is never told and `.parse` may
 *    reject → wasted retries. `paths` are structural field paths (not PII).
 *  - `streaming_disabled` — progressive `partial_object` streaming is off
 *    because the schema root isn't a `ZodObject` (`non-object`) or tools are
 *    present (`tools`).
 *  - `schema_prompt_none_no_guidance` — `schemaPrompt:'none'` was set with a
 *    schema and no override, so the model gets zero shape guidance (parse gate
 *    only). Emitted from the Problem-B path (spec 22 §5.3).
 */
export type SchemaDiagnosticData =
  | {
      kind: 'prompt_schema_oversized';
      estimatedTokens: number;
      threshold: number;
      site: 'prompt' | 'tool';
      tool?: string;
    }
  | {
      kind: 'dropped_refinements';
      count: number;
      paths?: string[];
      site: 'prompt' | 'tool';
      tool?: string;
    }
  | { kind: 'streaming_disabled'; rootType: string; cause: 'non-object' | 'tools' }
  | { kind: 'schema_prompt_none_no_guidance' }
  | {
      /** `nativeStructuredOutput` was requested but the resolved provider can't
       *  honor the derived schema — it downgrades it to plain JSON mode
       *  (`downgraded`), sanitizes it lossily (`lossy`, e.g. Gemini strips
       *  keywords), or ignores it structurally and relies on the prompt
       *  (`unsupported`, e.g. Anthropic). The call proceeds regardless (O5). */
      kind: 'native_output_unsupported';
      provider?: string;
      support: 'downgraded' | 'lossy' | 'unsupported';
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

/** Machine-readable completeness of an observation surface or execution trace. */
export type ObservationStatus =
  | { complete: true }
  | {
      complete: false;
      reason: 'queue_overflow';
      droppedEvents: number;
    }
  | {
      complete: false;
      reason: 'branch_drain_timeout';
      pendingContinuations: number;
      timeoutMs: number;
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
  /** Completeness of the terminal trace. Present on new executions; absent
   *  on historical events written before completeness signaling shipped. */
  observation?: ObservationStatus;
};

/** Data shape for `checkpoint_save` / `checkpoint_replay` events.
 *  Emitted by `ctx.checkpoint(name, fn)` — `save` on first execution,
 *  `replay` when a saved value short-circuits the function call. */
export type CheckpointEventData = {
  /** Stable, caller-supplied identifier under which the checkpoint is
   *  stored. Internal auto-checkpoints from ask/spawn/race/parallel/map
   *  use names prefixed with `__auto/<primitive>/`. */
  name: string;
};

/** Data shape for `await_human` events — emitted when execution suspends
 *  for a human decision via `ctx.awaitHuman()`. The pending side of the
 *  pair; `await_human_resolved` follows when the decision arrives. */
export type AwaitHumanData = {
  /** Optional human-facing prompt describing the decision needed. */
  prompt?: string;
  /** Channel routing the decision (e.g., 'slack', 'email', custom). */
  channel?: string;
};

/** Data shape for `await_human_resolved` events — paired terminal of an
 *  `await_human` request. Carries the `HumanDecision` returned to the workflow. */
export type AwaitHumanResolvedData = {
  channel?: string;
  decision: HumanDecision;
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
   *     across an execution gives the spend — a LOWER BOUND when any call
   *     used an unpriced model (its `cost` is `undefined` and contributes
   *     nothing; the owning `ask_end` sets `unpriced: true`).
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
type LegacyAxlEventPayloadV1 =
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
        /** True when a cost-bearing leaf in this ask did measurable work but had
         *  no usable cost (unpriced model / pricing-table miss). When set, `cost`
         *  is a LOWER BOUND — the unknown component is not included. Absent ⇒
         *  `cost` is exact. Surfaced so dashboards don't render a misleading
         *  exact `$0.00` for an ask that used an unpriced model. */
        unpriced?: boolean;
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
        /** Request-side payload — prompt, system, params, messages, retry context. */
        data: AgentCallStartData;
      })
  | (AxlEventBase &
      AskScoped & {
        type: 'agent_call_end';
        agent: string;
        model: string;
        /** Authoritative turn-level cost. `undefined` for an unpriced model
         *  (pricing-table miss) and absent on the error path (no usage). */
        cost?: number;
        duration: number;
        tokens?: { input?: number; output?: number; reasoning?: number };
        /** Response-side payload — response text, thinking. */
        data: AgentCallEndData;
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

  // ── Handoff (spans two asks — NOT AskScoped) ───────────────────────────
  //
  // Asymmetric by mode: oneway emits only `handoff_start` (no return trip);
  // roundtrip emits both `handoff_start` and `handoff_return`. This matches
  // the control flow — oneway terminates at the target, roundtrip returns
  // to source. `handoff_start` fires BEFORE the target ask begins, so it
  // orders correctly in step-sorted timelines (ahead of the target's
  // ask_start/agent_call_*/ask_end).
  | (AxlEventBase & {
      type: 'handoff_start';
      fromAskId: string;
      toAskId: string;
      sourceDepth: number;
      targetDepth: number;
      data: HandoffStartData;
    })
  | (AxlEventBase & {
      type: 'handoff_return';
      fromAskId: string;
      toAskId: string;
      sourceDepth: number;
      targetDepth: number;
      data: HandoffReturnData;
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
        /** The stage of the most recent `pipeline(start)` — `'initial'` when
         *  the ask committed on the first pass, otherwise the gate that last
         *  retried before commit. Lets consumers tell "committed cleanly"
         *  from "committed after a schema/validate/guardrail retry". */
        stage: 'initial' | 'schema' | 'validate' | 'guardrail';
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

  // ── Character-level deltas inside string values ─────────────────────────
  // Fires per text-delta chunk while the streaming walker is inside a
  // string value at a known path. Same gating as `partial_object`.
  // Stream-only — never persisted to `ExecutionInfo.events`.
  | (AxlEventBase &
      AskScoped & {
        type: 'string_delta';
        /** 1-indexed schema-retry attempt; mirrors `partial_object.attempt`. */
        attempt: number;
        data: StringDeltaData;
      })

  // ── Verification ────────────────────────────────────────────────────────
  | (AxlEventBase & AskScoped & { type: 'verify'; data: VerifyData })

  // ── Schema capability diagnostics (spec 22, Problem E) ──────────────────
  | (AxlEventBase & AskScoped & { type: 'schema_diagnostic'; data: SchemaDiagnosticData })

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

  // ── Scoped execution checkpoints (`ctx.checkpoint`) ─────────────────────
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'checkpoint_save' | 'checkpoint_replay';
        data: CheckpointEventData;
      })

  // ── Human-in-the-loop (`ctx.awaitHuman`) ────────────────────────────────
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'await_human';
        data: AwaitHumanData;
      })
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'await_human_resolved';
        data: AwaitHumanResolvedData;
      })

  // ── Terminal workflow markers (idiomatic names; see decision 9) ─────────
  | (AxlEventBase & { type: 'done'; data: { result: unknown } })
  | (AxlEventBase &
      Partial<AskScoped> & {
        type: 'error';
        data: { message: string; name?: string; code?: string };
      });

/** Tool lifecycle variants written by the v2 event schema. */
export type ToolLifecycleEventV2 =
  | (AxlEventBase &
      AskScoped & {
        schemaVersion: 2;
        type: 'tool_call_start';
        agent: string;
        tool: string;
        callId: string;
        data: ToolCallStartDataV2;
      })
  | (AxlEventBase &
      AskScoped & {
        schemaVersion: 2;
        type: 'tool_call_end';
        agent: string;
        tool: string;
        callId: string;
        duration: number;
        cost?: number;
        data: ToolCallEndData;
      })
  | (AxlEventBase &
      AskScoped & {
        schemaVersion: 2;
        type: 'tool_call_rejected';
        agent: string;
        tool: string;
        callId: string;
        data: ToolCallRejectedData;
      });

/** Event persisted by the legacy unversioned writer. Readers may normalize the
 * absent marker to an explicit `1` without reinterpreting its payload. */
export type LegacyAxlEventV1 = LegacyAxlEventPayloadV1 & { schemaVersion?: 1 };

/** Named v2 rejection event for consumers that do not need the full union. */
export type ToolCallRejectedEvent = Extract<ToolLifecycleEventV2, { type: 'tool_call_rejected' }>;

/** Event contract written by the next breaking runtime.
 *
 * This additive prototype lets consumers and type tests lock the schema before
 * the runtime writer switches. Every v2 event carries the version directly;
 * `tool_denied` and the v1 tool end shape cannot be represented.
 */
export type AxlEventV2 =
  | ToolLifecycleEventV2
  | (Exclude<
      LegacyAxlEventPayloadV1,
      { type: 'tool_call_start' | 'tool_call_end' | 'tool_denied' }
    > & {
      schemaVersion: 2;
    });

/** Current live event contract. Every emitted event is explicitly v2. */
export type AxlEvent = AxlEventV2;

/** Event returned by state-store and recovery readers during the migration. */
export type HistoricalAxlEvent = LegacyAxlEventV1 | AxlEventV2;

/** Convenience: extract a v2 union member by discriminator. */
export type AxlEventV2Of<T extends AxlEventV2['type']> = Extract<AxlEventV2, { type: T }>;

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
export type ExecutionInfoV1 = {
  executionId: string;
  workflow: string;
  status: ExecutionStatus;
  /** Full event timeline. Tokens and `partial_object` events are NOT persisted
   *  here (stream-only); aggregate `tokens: { input, output, reasoning? }`
   *  on `agent_call_end` is the persisted token representation. */
  events: LegacyAxlEventV1[];
  /** Total spend for the execution. A LOWER BOUND when an unpriced model ran
   *  (those calls contribute nothing) — read {@link ExecutionInfo.unpriced} to
   *  know whether it's exact, rather than scanning the event timeline. */
  totalCost: number;
  /** True when any cost-bearing leaf in this execution did billable work but had
   *  no usable cost (unpriced model / pricing-table miss): `totalCost` is then a
   *  LOWER BOUND, not exact. `false` means every cost-bearing call was priced.
   *  The aggregate counterpart of `ask_end.unpriced` / `BudgetResult.unpriced`,
   *  computed via `isUnpricedLeaf`. `undefined` only on executions recorded
   *  before this field existed (back-compat). */
  unpriced?: boolean;
  startedAt: number;
  completedAt?: number;
  duration: number;
  result?: unknown;
  error?: string;
  /** Completeness of the persisted event timeline. Absent on historical
   *  rows written before completeness signaling shipped. */
  observation?: ObservationStatus;
  /** Caller-supplied metadata threaded verbatim from `ExecuteOptions.metadata`
   *  (or `runtime.stream()`'s `options.metadata`). Persisted as part of the
   *  `ExecutionInfo` snapshot so callers have a stable, queryable surface for
   *  tags like `userId`, `tenantId`, or correlation ids without parsing the
   *  event timeline. Filter via `runtime.getExecutions()` + an in-process
   *  `.filter()`; secondary indexes on this field are intentionally not
   *  provided — `StateStore` is a persistence boundary, not a query engine. */
  metadata?: Record<string, unknown>;
};

/** Stored execution written before explicit event schema versioning. */
export type LegacyExecutionInfoV1 = ExecutionInfoV1 & {
  eventSchemaVersion?: 1;
};

/** Stored or live execution written by the v2 event writer. */
export type ExecutionInfoV2 = Omit<ExecutionInfoV1, 'events'> & {
  eventSchemaVersion: 2;
  events: AxlEventV2[];
};

/** Current live execution contract. Historical reads retain their explicit union. */
export type ExecutionInfo = ExecutionInfoV2;

/** Honest state-store read contract: missing version metadata means v1. */
export type HistoricalExecutionInfo = LegacyExecutionInfoV1 | ExecutionInfoV2;

/** Record of an agent handoff event (persisted in session metadata).
 *
 *  `duration` semantics:
 *    - `oneway`:    target's full ask duration (start-to-completion).
 *    - `roundtrip`: full round-trip wall-clock (handoff_start → handoff_return),
 *                   includes the time to push the result back into the source's
 *                   conversation. Both measurements are populated by the
 *                   runtime once the corresponding event fires; if the target
 *                   never completes (workflow aborted mid-handoff), `duration`
 *                   stays undefined.
 *
 *  `toAskId` is the askId of the target frame — lets consumers correlate
 *  the record to the target's `ask_end` event in the trace stream. */
export type HandoffRecord = {
  source: string;
  target: string;
  mode: 'oneway' | 'roundtrip';
  timestamp: number;
  duration?: number;
  toAskId?: string;
};

/** Information about a completed agent call, emitted via onAgentCallComplete. */
export type AgentCallInfo = {
  agent: string;
  prompt: string;
  response: string;
  model: string;
  cost: number;
  /** True when `cost` is a lower bound because the call tree included unpriced work. */
  unpriced: boolean;
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
  /** Name of the agent that produced this message. Populated on `assistant`
   *  messages committed via `ctx.ask()`; absent on `user` messages and on
   *  assistant messages pushed by external callers (e.g., the
   *  `Session.send` fallback when no agent context is available).
   *
   *  This is observability metadata only — it is NOT sent on the wire to
   *  any provider. Provider adapters cherry-pick the fields they need
   *  (`role`, `content`, `name`, `tool_calls`, `tool_call_id`) and ignore
   *  the rest. Future per-agent history filtering may consume this field
   *  (the option name and shape are not yet stable); today it is purely
   *  informational. */
  agent?: string;
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
