// Core API
export { tool } from './tool.js';
export type { Tool, ToolConfig, ToolHooks, RetryPolicy } from './tool.js';

export { agent } from './agent.js';
export type { Agent, AgentConfig, HandoffDescriptor } from './agent.js';

export { workflow } from './workflow.js';
export type { Workflow, WorkflowConfig } from './workflow.js';

// Runtime
export { AxlRuntime } from './runtime.js';
export type { CreateContextOptions, ExecuteOptions } from './runtime.js';
export { defineConfig } from './config.js';
export type { AxlConfig } from './config.js';

// Stream
export { AxlStream } from './stream.js';
/**
 * @deprecated Temporary re-export bridging the unified-event-model migration.
 *  The wire stream still synthesizes legacy stream events via a translation
 *  layer in `runtime.ts`; that layer (and this type) get deleted in the next
 *  commit, after which `AxlStream` carries `AxlEvent` directly. Migrate
 *  consumers to narrow on `AxlEvent` instead.
 */
export type { StreamEvent } from './stream.js';

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
  AxlEventType,
  AxlEventBase,
  AxlEventOf,
  AskScoped,
  CallbackMeta,
  // Per-type data shapes — consumers narrowing via `event.type` get
  // statically-typed access to `data`. Kept in the same export block as
  // `AxlEvent` so the discriminated union and its parts move together.
  AgentCallData,
  ToolCallData,
  ToolCallStartData,
  ToolApprovalData,
  ToolDeniedData,
  HandoffData,
  DelegateData,
  VerifyData,
  WorkflowStartData,
  WorkflowEndData,
  MemoryEventData,
  GuardrailData,
  SchemaCheckData,
  ValidateData,
  AskOptions,
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
export { AXL_EVENT_TYPES } from './types.js';

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
} from './errors.js';

// Provider
export { OpenAIProvider } from './providers/openai.js';
export { OpenAIResponsesProvider } from './providers/openai-responses.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { GeminiProvider } from './providers/gemini.js';
export { ProviderRegistry } from './providers/registry.js';
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
export { resolveThinkingOptions, type ResolvedThinkingOptions } from './providers/types.js';

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
