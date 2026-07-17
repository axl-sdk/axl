// Core API
export { tool } from './tool.js';
export type { Tool, ToolConfig, ToolHooks, ToolModelOutput, RetryPolicy } from './tool.js';

export { agent } from './agent.js';
export type { Agent, AgentConfig, HandoffDescriptor } from './agent.js';

export { workflow } from './workflow.js';
export type { Workflow, WorkflowConfig, AnyWorkflow } from './workflow.js';

// Runtime
export { AxlRuntime } from './runtime.js';
export type { CreateContextOptions, ExecuteOptions, EvalExecuteWorkflow } from './runtime.js';

// Module-resolution helpers — internal but exported so the eval CLI and
// Studio middleware share one implementation of the ESM/CJS interop walk.
// Not part of the stable public API.
export { resolveRuntime, pickDefault, pickExport } from './module-resolve.js';

// CLI internals — internal helpers for tsx loader registration, glob
// expansion, conditions registration, and config-file detection. Shared
// between axl-eval and axl-studio so a fix to (e.g.) the tsx loader
// applies to both atomically. Not part of the stable public API.
export {
  CONFIG_CANDIDATES,
  findConfig,
  needsTsxLoader,
  importModule,
  expandGlob,
  registerConditions,
} from './cli-internals.js';
export { defineConfig } from './config.js';
export type { AxlConfig } from './config.js';

// Stream — carries `AxlEvent` directly. No `StreamEvent` shim — consumers
// narrow on `event.type` from the `AxlEvent` union (spec/16 decision 8).
export { AxlStream } from './stream.js';

// Event bus — public type returned by `ctx.events` and the implementation
// behind `AxlStream`'s iterator + curated views (`.text`, `.lifecycle`,
// `.textByAsk`, `.partialObjects`).
export { AxlEventBus, EventStreamOverflowError } from './event-stream.js';
export type {
  CoalescedPartialObject,
  EventStreamOptions,
  StringStreamEvent,
  StringStreamFilter,
} from './event-stream.js';

// Wire-side reconstructor for the `stringStream` view. Lives in its own
// module — independent of `EventEmitter`-using `AxlEventBus` — so a
// browser SPA bundle cannot pull `node:events` when only this helper is
// imported, regardless of bundler tree-shaking aggressiveness.
export { stringStreamFromEvents } from './string-stream-from-events.js';

// Event helpers — consumer-facing utilities for accumulators / reducers
// that need to honor spec invariants (cost-rollup skip, root-level
// filter, leaf-cost detection). Use these instead of hand-rolling the
// `event.type !== 'ask_end'` guard at every call site.
export {
  eventCostContribution,
  isCostBearingLeaf,
  isUnpricedLeaf,
  isRootLevel,
  hasPositiveTokens,
  isUsableCost,
  COST_BEARING_LEAF_TYPES,
} from './event-utils.js';

// Tolerant JSON parser — used internally for `partial_object` streaming.
// Exported so consumers building their own progressive-render pipelines
// can reuse the same truncation recovery + stack-overflow guard rails
// we ship with the SDK.
export { parsePartialJson } from './partial-json.js';

// Persisted event-schema compatibility helpers.
export {
  getEventSchemaVersion,
  getExecutionEventSchemaVersion,
  normalizeStoredExecution,
  UnsupportedEventSchemaVersionError,
} from './event-schema.js';

// Session
export { Session } from './session.js';
export type { SessionOptions } from './session.js';

// Context
export { WorkflowContext, zodToJsonSchema, extractJson } from './context.js';
export type { WorkflowContextInit } from './context.js';
export type {
  Result,
  BudgetResult,
  HumanDecision,
  // Unified event model — replaces the old TraceEvent + StreamEvent split.
  AxlEvent,
  AxlEventV2,
  AxlEventV2Of,
  LegacyAxlEventV1,
  HistoricalAxlEvent,
  AxlEventType,
  AxlEventBase,
  AxlEventOf,
  AskScoped,
  CallbackMeta,
  // Per-type data shapes — consumers narrowing via `event.type` get
  // statically-typed access to `data`. Kept in the same export block as
  // `AxlEvent` so the discriminated union and its parts move together.
  AgentCallStartData,
  AgentCallEndData,
  AgentCallParams,
  ToolCallData,
  ToolArgumentIssue,
  ToolCallStartDataV2,
  ToolCallRejectedData,
  ToolCallRejectedEvent,
  ToolEventError,
  ToolFailure,
  ToolFailureConstructor,
  ToolFailureOptions,
  ToolCallFailure,
  ToolCallCancellation,
  ToolCallOutcome,
  ToolCallEndData,
  ToolLifecycleEventV2,
  ToolCallStartData,
  ToolApprovalData,
  ToolDeniedData,
  HandoffStartData,
  HandoffReturnData,
  DelegateData,
  VerifyData,
  WorkflowStartData,
  WorkflowEndData,
  MemoryEventData,
  CheckpointEventData,
  AwaitHumanData,
  AwaitHumanResolvedData,
  GuardrailData,
  SchemaCheckData,
  SchemaDiagnosticData,
  ValidateData,
  StringDeltaData,
  AskOptions,
  SchemaPromptOption,
  DelegateOptions,
  RaceOptions,
  VoteOptions,
  VerifyRetry,
  VerifyOptions,
  BudgetOptions,
  SpawnOptions,
  MapOptions,
  AwaitHumanOptions,
  ExecutionInfo,
  ExecutionInfoV1,
  LegacyExecutionInfoV1,
  ExecutionInfoV2,
  HistoricalExecutionInfo,
  GuardrailResult,
  InputGuardrail,
  OutputGuardrail,
  GuardrailBlockHandler,
  GuardrailsConfig,
  ValidateResult,
  OutputValidator,
  HandoffRecord,
  AgentCallInfo,
} from './types.js';
export { AXL_EVENT_TYPES, AXL_EVENT_TYPES_V2, AXL_TOOL_LIFECYCLE_TYPES_V2 } from './types.js';
export { REDACTED, REDACTION_RULES, redactEvent, redactHistoricalEvent } from './redaction.js';

// Errors
export {
  AxlError,
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  MaxTurnsError,
  ToolDenied,
  BudgetExceededError,
  GuardrailError,
  ValidationError,
  ToolModelOutputError,
} from './errors.js';
export { ProviderError, isRetryableStatus } from './providers/errors.js';
// NOTE: `RETRYABLE_STATUS_CODES` (retry.ts) is intentionally NOT exported — it's the
// narrow transport-retry set; consumers use `ProviderError.retryable` / `isRetryableStatus`.

// Provider
export { OpenAIProvider, OPENAI_PRICING, estimateOpenAICost } from './providers/openai.js';
export { OpenAIResponsesProvider } from './providers/openai-responses.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { GeminiProvider } from './providers/gemini.js';
// Generic OpenAI-compatible engine + profile types (build a custom provider preset).
export {
  OpenAICompatibleProvider,
  priceFromTable,
  resolvePerModel,
  reasoningEffortEmit,
  reasoningObjectEmit,
  ThinkTagScanner,
  extractThinkTags,
} from './providers/openai-compatible.js';
export { OPENAI_PROFILE, openaiReasoningEmit } from './providers/openai.js';
// Built-in OpenAI-compatible presets (clone + tweak for a custom provider).
export {
  BUILTIN_PROFILES,
  OPENROUTER_PROFILE,
  AZURE_PROFILE,
  XAI_PROFILE,
  DEEPSEEK_PROFILE,
  MISTRAL_PROFILE,
  GROQ_PROFILE,
  BEDROCK_PROFILE,
  OLLAMA_PROFILE,
  VLLM_PROFILE,
  LMSTUDIO_PROFILE,
  LLAMACPP_PROFILE,
  SGLANG_PROFILE,
} from './providers/profiles/index.js';
export type {
  ProviderProfile,
  CapabilityFlags,
  PricingSource,
  PricingTable,
  ReasoningProfile,
  ReasoningCapture,
  ReasoningRoundTrip,
  ReasoningEmit,
  AuthHeader,
  PerModel,
  OpenAICompatibleOptions,
} from './providers/openai-compatible.js';
export { ProviderRegistry } from './providers/registry.js';
export { RateLimiter } from './providers/rate-limiter.js';
export type { RateLimitConfig } from './providers/rate-limiter.js';
export type {
  Provider,
  ProviderAdapter,
  ChatMessage,
  ToolCallMessage,
  ProviderResponse,
  StreamChunk,
  ChatOptions,
  Effort,
  ToolChoice,
} from './providers/types.js';
export {
  resolveThinkingOptions,
  resolveApiKey,
  type ResolvedThinkingOptions,
  type ApiKeySource,
} from './providers/types.js';

// MCP
export { McpManager } from './mcp/manager.js';
export type { McpToolDefinition, McpServer, McpToolResult, McpServerConfig } from './mcp/types.js';

// State
export type {
  StateStore,
  ExecutionState,
  PendingDecision,
  EvalHistoryEntry,
} from './state/types.js';
export { MemoryStore } from './state/memory.js';
export { SQLiteStore } from './state/sqlite.js';
export { RedisStore } from './state/redis.js';

// Memory
export { MemoryManager } from './memory/manager.js';
export type { RememberResult, RecallResult } from './memory/manager.js';
export { OpenAIEmbedder } from './memory/embedder-openai.js';
export { InMemoryVectorStore } from './memory/vector-memory.js';
export { SqliteVectorStore } from './memory/vector-sqlite.js';
export type {
  VectorEntry,
  VectorResult,
  VectorStore,
  Embedder,
  EmbedResult,
  EmbedUsage,
  RememberOptions,
  RecallOptions,
  MemoryConfig,
} from './memory/types.js';

// Telemetry
export { NoopSpanManager, createSpanManager } from './telemetry/index.js';
export type { TelemetryConfig, SpanHandle, SpanManager } from './telemetry/types.js';
