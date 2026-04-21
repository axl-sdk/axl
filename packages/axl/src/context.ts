import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type {
  Result,
  BudgetResult,
  HumanDecision,
  BudgetOptions,
  MapOptions,
  SpawnOptions,
  VoteOptions,
  VerifyOptions,
  AwaitHumanOptions,
  AskOptions,
  DelegateOptions,
  RaceOptions,
  AxlEvent,
  CallbackMeta,
  ChatMessage,
  ToolCallMessage,
  ProviderResponse,
  AgentCallInfo,
  ValidateResult,
  VerifyRetry,
} from './types.js';
import {
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  MaxTurnsError,
  BudgetExceededError,
  GuardrailError,
  ValidationError,
} from './errors.js';
import type { Agent } from './agent.js';
import { parsePartialJson } from './partial-json.js';
import type { Provider, ChatOptions, ToolDefinition } from './providers/types.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { AxlConfig } from './config.js';
import { parseDuration, parseCost } from './config.js';
import type { StateStore } from './state/types.js';
import type { McpManager } from './mcp/manager.js';
import type { SpanManager } from './telemetry/types.js';
import type { MemoryManager } from './memory/manager.js';
import type { RememberOptions, RecallOptions, VectorResult } from './memory/types.js';

/**
 * AsyncLocalStorage for per-branch abort signals.
 * Used by race/spawn/map/budget to thread signals through async contexts
 * without mutating shared state on the WorkflowContext instance.
 */
const signalStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * Per-ask frame propagated via AsyncLocalStorage.
 *
 * - `askId` / `depth` / `agent`: identify the ask this event belongs to so
 *   consumers can group, indent, and link nested asks without consulting
 *   parent context.
 * - `parentAskId`: set on every nested frame so the consumer can reconstruct
 *   the ask tree; absent on the root ask.
 * - `parentToolCallId`: bridges the legacy correlation field. The tool
 *   execution path threads the outer tool's `callId` here so child contexts
 *   keep stamping `parentToolCallId` for telemetry consumers that haven't
 *   migrated yet (kept for one minor cycle alongside the new field).
 * - `stepRef`: a single mutable counter shared across the entire execution
 *   (root ask + every nested ask + every branch primitive). Atomically
 *   incremented on each event emission so `event.step` is monotonic across
 *   the whole tree, not per-context.
 */
type AskFrame = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent?: string;
  parentToolCallId?: string;
  stepRef: { value: number };
  /**
   * Cost incurred by THIS ask only — agent_call_end + tool_call_end events
   * emitted within this frame (NOT including nested asks, which have their
   * own frame and own counter). `emitEvent` increments this on every event
   * that carries `cost` as long as the event's frame matches `this`. Read
   * by `ask_end` to populate `cost` per spec decision 10.
   */
  askCost: { value: number };
};
const askStorage = new AsyncLocalStorage<AskFrame>();

/** Convert a Zod schema to JSON Schema. Exported for Studio tool introspection.
 *  Wraps Zod v4's built-in `z.toJSONSchema()`, stripping the `$schema` key
 *  since tool parameter schemas are embedded objects, not standalone documents. */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

/** Simple token estimator: ~4 chars per token. Good enough for context management. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract JSON from LLM response content.
 * Handles: raw JSON, markdown fenced blocks (```json ... ```),
 * and content with leading/trailing text around a JSON object/array.
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();

  // Content starts with { or [ — extract balanced JSON (handles trailing text)
  if (trimmed.startsWith('{')) {
    return extractBalanced(trimmed, 0, '{', '}') ?? trimmed;
  }
  if (trimmed.startsWith('[')) {
    return extractBalanced(trimmed, 0, '[', ']') ?? trimmed;
  }

  // Extract from markdown fenced code block
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find the first balanced { ... } or [ ... ]
  const open = trimmed.indexOf('{');
  if (open >= 0) {
    const extracted = extractBalanced(trimmed, open, '{', '}');
    if (extracted) return extracted;
  }

  const openBracket = trimmed.indexOf('[');
  if (openBracket >= 0) {
    const extracted = extractBalanced(trimmed, openBracket, '[', ']');
    if (extracted) return extracted;
  }

  // Nothing found — return as-is and let JSON.parse produce the error
  return trimmed;
}

/** Extract a balanced substring from `start` matching open/close chars, respecting JSON strings. */
function extractBalanced(
  str: string,
  start: number,
  openChar: string,
  closeChar: string,
): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/** Estimate tokens for a message array. */
/**
 * Append the assistant's failed attempt and the corrective feedback message to
 * the conversation so the next LLM turn sees both. Shared across guardrail,
 * schema_check, and validate retry paths — keeps the exact message shape in
 * one place so fixes (e.g. preserving providerMetadata for Gemini) apply to
 * all three gates at once.
 */
function appendRetryMessages(
  messages: ChatMessage[],
  content: string,
  feedbackMessage: string,
  providerMetadata?: Record<string, unknown>,
): void {
  messages.push({
    role: 'assistant',
    content,
    ...(providerMetadata ? { providerMetadata } : {}),
  });
  messages.push({ role: 'system', content: feedbackMessage });
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name + tc.function.arguments);
      }
    }
    total += 4; // per-message overhead (role, separators)
  }
  return total;
}

export type WorkflowContextInit = {
  input: unknown;
  executionId: string;
  metadata?: Record<string, unknown>;
  config: AxlConfig;
  providerRegistry: ProviderRegistry;
  sessionHistory?: ChatMessage[];
  onTrace?: (event: AxlEvent) => void;
  /** Per-token streaming callback. `meta` carries `askId`/`parentAskId`/
   *  `depth`/`agent` so consumers can route or filter (e.g., `meta.depth === 0`
   *  for root-only chat UIs). */
  onToken?: (token: string, meta: CallbackMeta) => void;
  /** Pre-execution tool-call callback. `meta` carries the ask correlation. */
  onToolCall?: (call: { name: string; args: unknown; callId?: string }, meta: CallbackMeta) => void;
  pendingDecisions?: Map<string, (d: HumanDecision) => void>;
  budgetContext?: {
    totalCost: number;
    limit: number;
    exceeded: boolean;
    policy: string;
    abortController?: AbortController;
  };
  stateStore?: StateStore;
  signal?: AbortSignal;
  workflowName?: string;
  mcpManager?: McpManager;
  /** SpanManager for OpenTelemetry instrumentation. */
  spanManager?: SpanManager;
  /** MemoryManager for ctx.remember() / ctx.recall() operations. */
  memoryManager?: MemoryManager;
  /** When true, the context replays from checkpoints before executing. */
  resumeMode?: boolean;
  /** Override tool handlers by name. Bypasses normal tool lookup in executeAgentCall. */
  toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
  /** Handler for awaitHuman — when set, returns immediately instead of waiting for pendingDecisions. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => HumanDecision | Promise<HumanDecision>;
  /** Callback fired when an agent LLM call is about to start. */
  onAgentStart?: (info: { agent: string; model: string }, meta: CallbackMeta) => void;
  /** Callback fired after each ctx.ask() completes (once per ask invocation). */
  onAgentCallComplete?: (call: AgentCallInfo) => void;
  /** Set by `createChildContext(parentToolCallId)` — stamped on every trace event
   *  emitted from this child so consumers can join nested agent calls back to
   *  the outer tool call that spawned them. */
  parentToolCallId?: string;
};

/**
 * The central coordination object for all Axl primitives.
 * Carries execution state, tracing, budget tracking, and session history.
 */
export class WorkflowContext<TInput = unknown> {
  readonly input: TInput;
  readonly executionId: string;
  readonly metadata: Record<string, unknown>;

  /**
   * Total cost accumulated by agent calls in this context.
   * Inside a `ctx.budget()` block, returns only that block's cost.
   * After the block completes, the nested cost is rolled up into the parent total.
   */
  get totalCost(): number {
    return this.budgetContext?.totalCost ?? 0;
  }

  private config: AxlConfig;
  private providerRegistry: ProviderRegistry;
  private sessionHistory: ChatMessage[];
  private onTrace?: (event: AxlEvent) => void;
  private onToken?: (token: string, meta: CallbackMeta) => void;
  private onToolCall?: (
    call: { name: string; args: unknown; callId?: string },
    meta: CallbackMeta,
  ) => void;
  private pendingDecisions?: Map<string, (d: HumanDecision) => void>;
  private budgetContext?: {
    totalCost: number;
    limit: number;
    exceeded: boolean;
    policy: string;
    abortController?: AbortController;
  };
  private stateStore?: StateStore;
  /** Root step counter for this execution. Inherited by every ctx.ask()
   *  frame so all events from this WorkflowContext (root + nested) share
   *  a single monotonic counter, even when concurrent branch primitives
   *  fire asks before any single parent ask exists. Per-instance so
   *  separate executions don't cross-talk. */
  private stepRefRoot: { value: number } = { value: 0 };
  private checkpointCounter = 0;
  private signal?: AbortSignal;
  private summaryCache?: string;
  private workflowName?: string;
  private mcpManager?: McpManager;
  private spanManager?: SpanManager;
  private memoryManager?: MemoryManager;
  private resumeMode: boolean;
  private toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
  private awaitHumanHandler?: (
    options: AwaitHumanOptions,
  ) => HumanDecision | Promise<HumanDecision>;
  private onAgentStart?: (info: { agent: string; model: string }, meta: CallbackMeta) => void;
  private onAgentCallComplete?: (call: AgentCallInfo) => void;
  private parentToolCallId?: string;
  constructor(init: WorkflowContextInit) {
    this.input = init.input as TInput;
    this.executionId = init.executionId;
    this.metadata = init.metadata ?? {};
    this.config = init.config;
    this.providerRegistry = init.providerRegistry;
    this.sessionHistory = init.sessionHistory ?? [];
    this.onTrace = init.onTrace;
    this.onToken = init.onToken;
    this.onToolCall = init.onToolCall;
    this.pendingDecisions = init.pendingDecisions;
    this.budgetContext = init.budgetContext;
    this.stateStore = init.stateStore;
    this.signal = init.signal;
    this.workflowName = init.workflowName;
    this.mcpManager = init.mcpManager;
    this.spanManager = init.spanManager;
    this.memoryManager = init.memoryManager;
    this.resumeMode = init.resumeMode ?? false;
    this.toolOverrides = init.toolOverrides;
    this.awaitHumanHandler = init.awaitHumanHandler;
    this.onAgentStart = init.onAgentStart;
    this.onAgentCallComplete = init.onAgentCallComplete;
    this.parentToolCallId = init.parentToolCallId;
    // Restore cached summary from session metadata (survives across requests)
    if (init.metadata?.summaryCache) {
      this.summaryCache = init.metadata.summaryCache as string;
    }
  }

  /**
   * Create a child context for nested agent invocations (e.g., agent-as-tool).
   * Shares: budget tracking, abort signals, trace emission, provider registry,
   *         state store, span manager, memory manager, MCP manager, config,
   *         awaitHuman handler, pending decisions, tool overrides, AND the
   *         streaming callbacks (onToken / onAgentStart / onToolCall).
   * Isolates: session history.
   *
   * Streaming callbacks now propagate into nested asks because every callback
   * invocation carries `meta.askId`/`meta.parentAskId`/`meta.depth` so
   * consumers that want root-only behavior can filter on `meta.depth === 0`
   * instead of relying on the runtime to drop nested events. This is the
   * "nested ask visibility" fix from spec §3.2.
   *
   * The shared step counter lives in `askStorage` (ALS), so there is no
   * per-context counter to pass through anymore.
   *
   * @param parentToolCallId - The `callId` of the outer `tool_call` that
   *   spawned this child. Threaded through `askStorage` so nested asks can
   *   stamp `parentToolCallId` on their events for legacy telemetry consumers.
   */
  createChildContext(parentToolCallId?: string): WorkflowContext {
    return new WorkflowContext({
      input: this.input,
      executionId: this.executionId,
      config: this.config,
      providerRegistry: this.providerRegistry,
      metadata: { ...this.metadata },
      // Shared infrastructure
      budgetContext: this.budgetContext,
      stateStore: this.stateStore,
      mcpManager: this.mcpManager,
      spanManager: this.spanManager,
      memoryManager: this.memoryManager,
      onTrace: this.onTrace,
      onToken: this.onToken,
      onToolCall: this.onToolCall,
      onAgentStart: this.onAgentStart,
      onAgentCallComplete: this.onAgentCallComplete,
      awaitHumanHandler: this.awaitHumanHandler,
      pendingDecisions: this.pendingDecisions,
      toolOverrides: this.toolOverrides,
      signal: this.signal,
      workflowName: this.workflowName,
      // Join key for nested event correlation. Inherit the parent's
      // `parentToolCallId` when this child is itself nested inside another
      // child — so grand-children still point to the outermost tool call.
      parentToolCallId: parentToolCallId ?? this.parentToolCallId,
      // Isolated: sessionHistory (empty)
    });
  }

  /**
   * Resolve the current abort signal.
   * Branch-scoped signals (from race/spawn/map/budget) in AsyncLocalStorage
   * take priority over the instance-level signal.
   */
  private get currentSignal(): AbortSignal | undefined {
    return signalStorage.getStore() ?? this.signal;
  }

  /**
   * Build a `CallbackMeta` for the current ask frame. Used at every
   * `onToken`/`onToolCall`/`onAgentStart` call site so consumers can
   * route or filter by ask correlation (`meta.depth === 0` for root
   * chat UIs, etc.).
   *
   * If the call is somehow outside an ask frame (e.g., a programmatic
   * `tool.run()` test harness), falls back to a synthetic meta keyed off
   * `executionId` so the type contract holds — consumers see `depth: 0`
   * and can ignore those events.
   */
  private currentCallbackMeta(agentName: string): CallbackMeta {
    const frame = askStorage.getStore();
    if (frame) {
      return {
        askId: frame.askId,
        ...(frame.parentAskId ? { parentAskId: frame.parentAskId } : {}),
        depth: frame.depth,
        agent: agentName,
      };
    }
    return { askId: this.executionId, depth: 0, agent: agentName };
  }

  // ── ctx.ask() ─────────────────────────────────────────────────────────

  async ask<T = string>(agent: Agent, prompt: string, options?: AskOptions<T>): Promise<T> {
    return this._checkpoint(async () => {
      // Allocate the ask frame BEFORE entering askStorage.run so the
      // emitEvent calls inside the run() callback see the new frame in ALS.
      const parentFrame = askStorage.getStore();
      const askId = randomUUID();
      const depth = (parentFrame?.depth ?? -1) + 1;
      // Nested asks inherit the parent frame's counter; top-level asks
      // share the WorkflowContext's instance-level `stepRefRoot` so all
      // top-level asks (including concurrent ones from spawn / parallel /
      // race) share a single monotonic counter. Spec §3.7.
      const stepRef = parentFrame?.stepRef ?? this.stepRefRoot;
      const frame: AskFrame = {
        askId,
        parentAskId: parentFrame?.askId,
        depth,
        agent: agent._name,
        // Inherit the parent's tool-call correlation so legacy consumers
        // see the outermost tool call across nested asks. The instance-level
        // `parentToolCallId` (set by `createChildContext`) takes priority.
        parentToolCallId: this.parentToolCallId ?? parentFrame?.parentToolCallId,
        stepRef,
        askCost: { value: 0 },
      };

      return askStorage.run(frame, async () => {
        const askStart = Date.now();
        this.emitEvent({ type: 'ask_start', prompt });

        // `costBefore` snapshots the global budget so we can pass the per-ask
        // cost delta to onAgentCallComplete (legacy callback that reports the
        // whole-tree spend). `frame.askCost` is the spec-correct, this-ask-only
        // figure used on `ask_end` (decision 10).
        const costBefore = this.budgetContext?.totalCost ?? 0;
        const resolveCtx = options?.metadata
          ? { metadata: { ...this.metadata, ...options.metadata } }
          : { metadata: this.metadata };

        // Use a mutable container to capture usage from executeAgentCall
        // without relying on an instance property (which is racy under
        // concurrent calls).
        const usageCapture: {
          value?: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            cached_tokens?: number;
          };
        } = {};

        const doCall = async () => {
          const result = await this.executeAgentCall(
            agent,
            prompt,
            options as AskOptions<unknown>,
            undefined,
            usageCapture,
          );
          return result as T;
        };

        let result: T;
        try {
          result = this.spanManager
            ? await this.spanManager.withSpanAsync(
                'axl.agent.ask',
                {
                  'axl.agent.name': agent._name,
                  'axl.agent.model': agent.resolveModel(resolveCtx),
                },
                async (span) => {
                  const r = await doCall();
                  const costAfter = this.budgetContext?.totalCost ?? 0;
                  span.setAttribute('axl.agent.cost', costAfter - costBefore);
                  span.setAttribute('axl.agent.duration', Date.now() - askStart);
                  if (usageCapture.value) {
                    span.setAttribute('axl.agent.prompt_tokens', usageCapture.value.prompt_tokens);
                    span.setAttribute(
                      'axl.agent.completion_tokens',
                      usageCapture.value.completion_tokens,
                    );
                    if (usageCapture.value.cached_tokens)
                      span.setAttribute(
                        'axl.agent.cached_tokens',
                        usageCapture.value.cached_tokens,
                      );
                  }
                  return r;
                },
              )
            : await doCall();
        } catch (err) {
          // Ask-internal failure surfaces via ask_end with outcome.ok:false
          // (spec decision 9). The workflow-level `error` event is reserved
          // for failures with no ask_end available — consumers must never
          // see both for the same failure.
          this.emitEvent({
            type: 'ask_end',
            outcome: { ok: false, error: err instanceof Error ? err.message : String(err) },
            cost: frame.askCost.value,
            duration: Date.now() - askStart,
          });
          throw err;
        }

        const costAfter = this.budgetContext?.totalCost ?? 0;
        this.onAgentCallComplete?.({
          agent: agent._name,
          prompt,
          response: typeof result === 'string' ? result : JSON.stringify(result),
          model: agent.resolveModel(resolveCtx),
          cost: costAfter - costBefore,
          duration: Date.now() - askStart,
          promptVersion: agent._config.version,
          temperature: options?.temperature ?? agent._config.temperature,
          maxTokens: options?.maxTokens ?? agent._config.maxTokens ?? 4096,
          effort: options?.effort ?? agent._config.effort,
          thinkingBudget: options?.thinkingBudget ?? agent._config.thinkingBudget,
          includeThoughts: options?.includeThoughts ?? agent._config.includeThoughts,
          toolChoice: options?.toolChoice ?? agent._config.toolChoice,
          stop: options?.stop ?? agent._config.stop,
          providerOptions: options?.providerOptions ?? agent._config.providerOptions,
        });
        this.emitEvent({
          type: 'ask_end',
          outcome: { ok: true, result },
          cost: frame.askCost.value,
          duration: Date.now() - askStart,
        });
        return result;
      });
    });
  }

  private async executeAgentCall(
    agent: Agent,
    prompt: string,
    options?: AskOptions<unknown>,
    handoffMessages?: ChatMessage[],
    usageCapture?: {
      value?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cached_tokens?: number;
      };
    },
  ): Promise<unknown> {
    // Budget check
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy === 'warn') {
        this.emitEvent({
          type: 'log',
          data: { warning: 'Budget exceeded', limit, spent, policy },
        });
      } else if (policy === 'finish_and_stop') {
        throw new BudgetExceededError(limit, spent, policy);
      } else {
        // hard_stop: the AbortController in budget() handles in-flight cancellation.
        // This path is reached on the *next* ctx.ask() call after budget was exceeded.
        throw new BudgetExceededError(limit, spent, policy);
      }
    }

    // Merge workflow metadata with per-call metadata (per-call takes precedence)
    const resolveCtx = options?.metadata
      ? { metadata: { ...this.metadata, ...options.metadata } }
      : { metadata: this.metadata };
    const modelUri = agent.resolveModel(resolveCtx);
    const systemPrompt = agent.resolveSystem(resolveCtx);
    const { provider, model } = this.providerRegistry.resolve(modelUri, this.config);

    // Resolve dynamic handoffs once per call to ensure consistency
    // between tool definitions and handoff lookup within the same turn.
    let resolvedHandoffs:
      | Array<{ agent: Agent; description?: string; mode?: 'oneway' | 'roundtrip' }>
      | undefined;
    if (typeof agent._config.handoffs === 'function') {
      try {
        resolvedHandoffs = agent._config.handoffs(resolveCtx);
      } catch (err) {
        this.log('handoff_resolve_error', {
          agent: agent._name,
          error: err instanceof Error ? err.message : String(err),
        });
        resolvedHandoffs = undefined;
      }
    } else {
      resolvedHandoffs = agent._config.handoffs;
    }

    // Build tool definitions
    const toolDefs = this.buildToolDefs(agent, resolvedHandoffs);

    // Build messages
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Include session history (with context window management)
    const maxContext = agent._config.maxContext;
    if (maxContext && this.sessionHistory.length > 0) {
      const reserveTokens = this.config.contextManagement?.reserveTokens ?? 2000;
      const systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
      const toolTokens = toolDefs.length > 0 ? estimateTokens(JSON.stringify(toolDefs)) : 0;
      const overhead = systemTokens + toolTokens + reserveTokens;
      const availableForHistory = maxContext - overhead;

      const historyTokens = estimateMessagesTokens(this.sessionHistory);
      if (historyTokens > availableForHistory) {
        // Need to summarize: find the split point
        const summarizedMessages = await this.summarizeHistory(
          provider,
          model,
          this.sessionHistory,
          availableForHistory,
        );
        for (const msg of summarizedMessages) {
          messages.push(msg);
        }
      } else {
        for (const msg of this.sessionHistory) {
          messages.push(msg);
        }
      }
    } else {
      for (const msg of this.sessionHistory) {
        messages.push(msg);
      }
    }

    // Build user prompt
    let userContent = prompt;
    if (options?.schema) {
      const jsonSchema = zodToJsonSchema(options.schema as z.ZodType);
      userContent += `\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
    }

    messages.push({ role: 'user', content: userContent });

    // If this agent was reached via handoff, include the source agent's conversation
    if (handoffMessages && handoffMessages.length > 0) {
      // Inject handoff context as a system message summarizing the source agent's work,
      // then append the raw tool-call exchanges so the target agent has full context.
      const handoffContext = handoffMessages.filter(
        (m) => m.role === 'assistant' || m.role === 'tool',
      );
      if (handoffContext.length > 0) {
        messages.push({
          role: 'system',
          content:
            'The following is the conversation history from the previous agent that handed off to you:',
        });
        for (const msg of handoffContext) {
          // Flatten tool messages into user messages to avoid protocol issues
          const content =
            msg.role === 'tool'
              ? `[Tool result for ${msg.tool_call_id}]: ${msg.content}`
              : msg.content;
          // Skip empty content (e.g. assistant messages with only tool calls)
          if (!content) continue;
          messages.push({ role: 'user', content });
        }
      }
    }

    // -- Input guardrail --
    const guardrails = agent._config.guardrails;
    if (guardrails?.input) {
      const inputResult = await guardrails.input(prompt, { metadata: this.metadata });
      this.emitEvent({
        type: 'guardrail',
        agent: agent._name,
        data: {
          guardrailType: 'input',
          blocked: inputResult.block,
          ...(inputResult.reason ? { reason: inputResult.reason } : {}),
          // Input guardrails can't retry (prompt is user-supplied), so attempt
          // and maxAttempts are always 1 — emit them for shape consistency with
          // output guardrails so consumers don't need two narrowers.
          attempt: 1,
          maxAttempts: 1,
        },
      });
      this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': inputResult.block,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 1,
        ...(inputResult.reason ? { 'axl.guardrail.reason': inputResult.reason } : {}),
      });
      if (inputResult.block) {
        const onBlock = guardrails.onBlock ?? 'throw';
        if (typeof onBlock === 'function') {
          return onBlock(inputResult.reason ?? 'Input blocked by guardrail', {
            metadata: this.metadata,
          });
        }
        // 'retry' behaves as 'throw' for input guardrails (prompt is user-supplied, can't retry)
        throw new GuardrailError('input', inputResult.reason ?? 'Input blocked by guardrail');
      }
    }

    const maxTurns = agent._config.maxTurns ?? 25;
    const timeoutMs = parseDuration(agent._config.timeout ?? '60s');
    const startTime = Date.now();

    // Streaming + validate is supported as of the unified event model
    // (spec §4.1). With pipeline events landing in PR 2, retry boundaries
    // are visible to consumers via `pipeline(status: 'failed' | 'committed')`
    // and `AxlStream.fullText` only commits the winning attempt's tokens.
    // Until pipeline events ship, retried tokens still concatenate; the
    // tradeoff is acceptable because the throw was a worse failure mode
    // (refused to run a valid configuration).

    const currentMessages = [...messages];
    let turns = 0;
    let guardrailOutputRetries = 0;
    let schemaRetries = 0;
    let validateRetries = 0;
    const maxGuardrailRetries = guardrails?.maxRetries ?? 2;
    // Set before `continue`ing to a retry turn; read when emitting the next
    // agent_call so consumers can see *why* a given LLM call is a retry.
    let pendingRetryReason: 'schema' | 'validate' | 'guardrail' | undefined;
    // `trace.level === 'full'` opts into verbose traces: we include the full ChatMessage[]
    // snapshot on each agent_call so the trace explorer can reconstruct exactly what the
    // model saw (growing with tool results + retry feedback across turns).
    const verboseTrace = this.config.trace?.level === 'full';

    // Track the most recent pipeline `start` so the terminal `committed`
    // event can carry the matching attempt/maxAttempts. Spec §4.2.
    let lastStartAttempt = 1;
    let lastStartMaxAttempts = 1;

    while (turns < maxTurns) {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        throw new TimeoutError('ctx.ask()', timeoutMs);
      }

      turns++;
      // Emit pipeline `start` only on the FIRST turn of the ask OR when
      // entering a gate-rejection retry. Tool-calling continuations
      // within the same ask do NOT produce additional starts — they're
      // agent-loop iterations, not retry attempts. Spec §4.2 invariant.
      const isFirstTurn = turns === 1;
      const isRetryTurn = pendingRetryReason !== undefined;
      if (isFirstTurn || isRetryTurn) {
        const stage: 'initial' | 'schema' | 'validate' | 'guardrail' =
          pendingRetryReason ?? 'initial';
        let pipelineAttempt = 1;
        let pipelineMaxAttempts = 1;
        if (stage === 'guardrail') {
          pipelineAttempt = guardrailOutputRetries + 1;
          pipelineMaxAttempts = maxGuardrailRetries + 1;
        } else if (stage === 'schema') {
          pipelineAttempt = schemaRetries + 1;
          pipelineMaxAttempts = (options?.retries ?? 3) + 1;
        } else if (stage === 'validate') {
          pipelineAttempt = validateRetries + 1;
          pipelineMaxAttempts = (options?.validateRetries ?? 2) + 1;
        }
        lastStartAttempt = pipelineAttempt;
        lastStartMaxAttempts = pipelineMaxAttempts;
        this.emitEvent({
          type: 'pipeline',
          agent: agent._name,
          status: 'start',
          stage,
          attempt: pipelineAttempt,
          maxAttempts: pipelineMaxAttempts,
        });
      }
      // Per-turn start time for accurate `duration` on each agent_call event.
      // `startTime` above is the start of the entire ask() call; without this,
      // turn N's duration would include all prior turns' latency and gates.
      const turnStart = Date.now();

      const chatOptions: ChatOptions = {
        model,
        temperature: options?.temperature ?? agent._config.temperature,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: options?.maxTokens ?? agent._config.maxTokens ?? 4096,
        effort: options?.effort ?? agent._config.effort,
        thinkingBudget: options?.thinkingBudget ?? agent._config.thinkingBudget,
        includeThoughts: options?.includeThoughts ?? agent._config.includeThoughts,
        toolChoice: options?.toolChoice ?? agent._config.toolChoice,
        stop: options?.stop ?? agent._config.stop,
        providerOptions: options?.providerOptions ?? agent._config.providerOptions,
        signal: this.currentSignal,
      };

      // If schema requested and no tools, use JSON mode
      if (options?.schema && toolDefs.length === 0) {
        chatOptions.responseFormat = { type: 'json_object' };
      }

      const callbackMeta = this.currentCallbackMeta(agent._name);
      this.emitEvent({
        type: 'agent_call_start',
        agent: agent._name,
        model: modelUri,
        turn: turns,
      });
      this.onAgentStart?.({ agent: agent._name, model: modelUri }, callbackMeta);

      let response: ProviderResponse;

      if (this.onToken) {
        // Use streaming to emit tokens in real-time
        let content = '';
        const toolCalls: ToolCallMessage[] = [];
        const toolCallBuffers = new Map<string, { id: string; name: string; arguments: string }>();
        let streamProviderMetadata: Record<string, unknown> | undefined;

        let thinkingContent = '';

        // partial_object emission gating (spec §4.2):
        //   - schema is set
        //   - no tools (JSON-mode response, not tool-calling)
        //   - schema root is a ZodObject (only object roots get partials)
        // Structural-boundary throttle: emit when we cross a `,`, `}`, or
        // `]` that is OUTSIDE a string literal. A naive "last char of
        // delta is a comma" check (review B-9) over-emits on prose-heavy
        // fields like {"description": "short, comma-heavy text..."} —
        // every comma inside the string triggered a parse. We track
        // in-string + escape state across chunks with a small walker so
        // each boundary fires exactly once at a real structural seam.
        const partialObjectEnabled =
          !!options?.schema && toolDefs.length === 0 && options.schema instanceof z.ZodObject;
        const currentAttempt = schemaRetries + 1;
        // Running parser state for the delta walker. Reset per ask
        // invocation (not per retry — schema retry feeds the same
        // conversation back, so we want a fresh parse of the new attempt).
        let inString = false;
        let escaped = false;
        let boundaryPending = false;

        for await (const chunk of provider.stream(currentMessages, chatOptions)) {
          if (chunk.type === 'text_delta') {
            content += chunk.content;
            // Emit a `token` AxlEvent so wire consumers (AxlStream) and
            // trace listeners both see it. Stream-only — `runtime.execute`'s
            // onTrace skips persisting tokens to ExecutionInfo.events.
            this.emitEvent({ type: 'token', data: chunk.content });
            this.onToken(chunk.content, callbackMeta);
            if (partialObjectEnabled) {
              // Walk `chunk.content` char-by-char, updating the
              // in-string / escape state and recording whether a
              // structural boundary landed outside a string. The
              // running state survives across chunks because
              // `inString` / `escaped` are closed over by the outer
              // for-await loop.
              for (const ch of chunk.content) {
                if (escaped) {
                  escaped = false;
                  continue;
                }
                if (ch === '\\') {
                  // Inside a string, `\\` starts an escape. Outside,
                  // a bare backslash is invalid JSON — treat the same
                  // way (swallow the next char) so malformed input
                  // doesn't derail our state machine.
                  escaped = true;
                  continue;
                }
                if (ch === '"') {
                  inString = !inString;
                  continue;
                }
                if (!inString && (ch === ',' || ch === '}' || ch === ']')) {
                  boundaryPending = true;
                }
              }
              if (boundaryPending) {
                boundaryPending = false;
                let parsed: unknown;
                try {
                  parsed = parsePartialJson(extractJson(content));
                } catch {
                  // Mid-document malformed (not just truncation) — skip
                  // this delta. The next structural boundary outside a
                  // string will get another shot once the model writes
                  // valid syntax.
                  parsed = undefined;
                }
                if (parsed !== undefined) {
                  this.emitEvent({
                    type: 'partial_object',
                    agent: agent._name,
                    attempt: currentAttempt,
                    data: { object: parsed },
                  });
                }
              }
            }
          } else if (chunk.type === 'thinking_delta') {
            thinkingContent += chunk.content;
          } else if (chunk.type === 'tool_call_delta') {
            let buffer = toolCallBuffers.get(chunk.id);
            if (!buffer) {
              buffer = { id: chunk.id, name: '', arguments: '' };
              toolCallBuffers.set(chunk.id, buffer);
            }
            if (chunk.name) buffer.name = chunk.name;
            if (chunk.arguments) buffer.arguments += chunk.arguments;
          } else if (chunk.type === 'done') {
            streamProviderMetadata = chunk.providerMetadata;
            // Usage and cost info from done chunk if available
            if (chunk.usage) {
              response = {
                content,
                tool_calls: undefined,
                usage: chunk.usage,
                cost: chunk.cost,
              };
            }
          }
        }

        // Convert tool call buffers to ToolCallMessage format
        for (const buffer of toolCallBuffers.values()) {
          toolCalls.push({
            id: buffer.id,
            type: 'function',
            function: {
              name: buffer.name,
              arguments: buffer.arguments,
            },
          });
        }

        response ??= {
          content,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        if (toolCalls.length > 0) {
          response.tool_calls = toolCalls;
        }
        if (streamProviderMetadata) {
          response.providerMetadata = streamProviderMetadata;
        }
        if (thinkingContent) {
          response.thinking_content = thinkingContent;
        }
      } else {
        response = await provider.chat(currentMessages, chatOptions);
      }

      // Capture usage for span instrumentation (per-call, not per-instance)
      if (usageCapture && response.usage) {
        usageCapture.value = response.usage;
      }

      // Track cost
      if (response.cost) {
        this._accumulateBudgetCost(response.cost);
      }

      // Snapshot of what we actually sent the provider this turn (excluding the
      // new assistant message that's about to be appended). Consumers can use
      // this to reconstruct the model's exact view on any given turn.
      // structuredClone avoids sharing references with `currentMessages` — later
      // turns mutate pushed-into arrays (e.g. tool_calls), and async consumers
      // would otherwise see post-mutation state. Wrapped in try/catch because
      // exotic `providerMetadata` (e.g. a future provider attaching a Function
      // or Buffer) would throw — we'd rather log the issue and keep the
      // workflow running than crash on an observability snapshot.
      let messagesSnapshot: ChatMessage[] | undefined;
      if (verboseTrace) {
        try {
          messagesSnapshot = structuredClone(currentMessages);
        } catch (err) {
          console.warn(
            '[axl] verbose trace messages snapshot failed to clone; emitting shallow copy:',
            err instanceof Error ? err.message : String(err),
          );
          messagesSnapshot = [...currentMessages];
        }
      }

      const retryReason = pendingRetryReason;
      pendingRetryReason = undefined;

      this.emitEvent({
        type: 'agent_call_end',
        agent: agent._name,
        model: modelUri,
        promptVersion: agent._config.version,
        cost: response.cost,
        tokens: response.usage
          ? {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
              reasoning: response.usage.reasoning_tokens,
            }
          : undefined,
        duration: Date.now() - turnStart,
        data: {
          prompt,
          response: response.content,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(response.thinking_content ? { thinking: response.thinking_content } : {}),
          params: {
            ...(chatOptions.temperature !== undefined
              ? { temperature: chatOptions.temperature }
              : {}),
            maxTokens: chatOptions.maxTokens,
            ...(chatOptions.effort !== undefined ? { effort: chatOptions.effort } : {}),
            ...(chatOptions.thinkingBudget !== undefined
              ? { thinkingBudget: chatOptions.thinkingBudget }
              : {}),
            ...(chatOptions.includeThoughts !== undefined
              ? { includeThoughts: chatOptions.includeThoughts }
              : {}),
            ...(chatOptions.toolChoice !== undefined ? { toolChoice: chatOptions.toolChoice } : {}),
            ...(chatOptions.stop !== undefined ? { stop: chatOptions.stop } : {}),
          },
          turn: turns,
          ...(retryReason ? { retryReason } : {}),
          ...(messagesSnapshot ? { messages: messagesSnapshot } : {}),
        },
      });

      // Handle tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
          ...(response.providerMetadata ? { providerMetadata: response.providerMetadata } : {}),
        });

        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name;

          // Check for handoff
          if (toolName.startsWith('handoff_to_')) {
            const targetName = toolName.replace('handoff_to_', '');
            const descriptor = resolvedHandoffs?.find((h) => h.agent._name === targetName);
            if (descriptor) {
              const mode = descriptor.mode ?? 'oneway';

              // For roundtrip, parse the message parameter from tool call args
              let handoffPrompt = prompt;
              if (mode === 'roundtrip') {
                try {
                  const args = JSON.parse(toolCall.function.arguments);
                  if (args.message) handoffPrompt = args.message;
                } catch {
                  // Fall back to original prompt if args can't be parsed
                }
              }

              const handoffStart = Date.now();
              // Capture the source ask's frame for handoff correlation.
              // `toAskId` is synthesized — handoff targets don't currently
              // create their own ask frame (target invocation goes through
              // the internal executeAgentCall path, not ctx.ask). For PR 1
              // we surface a sentinel UUID so the wire shape matches spec
              // §2.1; full target-frame integration is a follow-up.
              const sourceFrame = askStorage.getStore();
              const handoffFromAskId = sourceFrame?.askId ?? this.executionId;
              const handoffSourceDepth = sourceFrame?.depth ?? 0;
              const handoffToAskId = randomUUID();
              const handoffTargetDepth = handoffSourceDepth + 1;

              // Pass accumulated messages so the target agent can see the source agent's work.
              // Forward schema/retries/validate/metadata — the target agent uses its own model params.
              const handoffOptions = options
                ? {
                    schema: options.schema,
                    retries: options.retries,
                    metadata: options.metadata,
                    validate: options.validate,
                    validateRetries: options.validateRetries,
                  }
                : undefined;
              const handoffFn = () =>
                this.executeAgentCall(
                  descriptor.agent,
                  handoffPrompt,
                  handoffOptions,
                  currentMessages,
                  usageCapture,
                );

              if (mode === 'roundtrip') {
                // Roundtrip: execute target, feed result back to source as tool response
                const executeRoundtrip = async (): Promise<unknown> => {
                  const result = await handoffFn();
                  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                  currentMessages.push({
                    role: 'tool',
                    content: resultStr,
                    tool_call_id: toolCall.id,
                  });
                  return result;
                };

                if (this.spanManager) {
                  await this.spanManager.withSpanAsync(
                    'axl.agent.handoff',
                    {
                      'axl.handoff.source': agent._name,
                      'axl.handoff.target': targetName,
                      'axl.handoff.mode': mode,
                    },
                    async (span) => {
                      const result = await executeRoundtrip();
                      const duration = Date.now() - handoffStart;
                      span.setAttribute('axl.handoff.duration', duration);
                      this.emitEvent({
                        type: 'handoff',
                        agent: agent._name,
                        fromAskId: handoffFromAskId,
                        toAskId: handoffToAskId,
                        sourceDepth: handoffSourceDepth,
                        targetDepth: handoffTargetDepth,
                        data: {
                          source: agent._name,
                          target: targetName,
                          mode,
                          duration,
                          ...(handoffPrompt !== prompt ? { message: handoffPrompt } : {}),
                        },
                      });
                      return result;
                    },
                  );
                } else {
                  await executeRoundtrip();
                  this.emitEvent({
                    type: 'handoff',
                    agent: agent._name,
                    fromAskId: handoffFromAskId,
                    toAskId: handoffToAskId,
                    sourceDepth: handoffSourceDepth,
                    targetDepth: handoffTargetDepth,
                    data: {
                      source: agent._name,
                      target: targetName,
                      mode,
                      duration: Date.now() - handoffStart,
                      ...(handoffPrompt !== prompt ? { message: handoffPrompt } : {}),
                    },
                  });
                }
                continue; // Source agent loop continues
              }

              // Oneway (default): return target's result, exiting source's loop
              if (this.spanManager) {
                return this.spanManager.withSpanAsync(
                  'axl.agent.handoff',
                  {
                    'axl.handoff.source': agent._name,
                    'axl.handoff.target': targetName,
                    'axl.handoff.mode': mode,
                  },
                  async (span) => {
                    const result = await handoffFn();
                    const duration = Date.now() - handoffStart;
                    span.setAttribute('axl.handoff.duration', duration);
                    this.emitEvent({
                      type: 'handoff',
                      agent: agent._name,
                      fromAskId: handoffFromAskId,
                      toAskId: handoffToAskId,
                      sourceDepth: handoffSourceDepth,
                      targetDepth: handoffTargetDepth,
                      data: { source: agent._name, target: targetName, mode, duration },
                    });
                    return result;
                  },
                );
              }
              const onewayResult = await handoffFn();
              this.emitEvent({
                type: 'handoff',
                agent: agent._name,
                fromAskId: handoffFromAskId,
                toAskId: handoffToAskId,
                sourceDepth: handoffSourceDepth,
                targetDepth: handoffTargetDepth,
                data: {
                  source: agent._name,
                  target: targetName,
                  mode,
                  duration: Date.now() - handoffStart,
                },
              });
              return onewayResult;
            }
          }

          // Check toolOverrides first (for mock tool interception)
          const toolOverride = this.toolOverrides?.get(toolName);
          if (toolOverride) {
            let toolArgs: unknown;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              currentMessages.push({
                role: 'tool',
                content: `Error: Invalid JSON in tool arguments. Please provide valid JSON.`,
                tool_call_id: toolCall.id,
              });
              continue;
            }
            this.emitEvent({
              type: 'tool_call_start',
              tool: toolName,
              callId: toolCall.id,
              data: { args: toolArgs },
            });
            this.onToolCall?.(
              { name: toolName, args: toolArgs, callId: toolCall.id },
              callbackMeta,
            );
            const toolStart = Date.now();

            const executeOverride = async () => {
              let toolResult: unknown;
              try {
                toolResult = await toolOverride(toolArgs);
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
              }
              return toolResult;
            };

            const toolResult = this.spanManager
              ? await this.spanManager.withSpanAsync(
                  'axl.tool.call',
                  {
                    'axl.tool.name': toolName,
                    'axl.agent.name': agent._name,
                  },
                  async (span) => {
                    const r = await executeOverride();
                    span.setAttribute('axl.tool.duration', Date.now() - toolStart);
                    const isError =
                      r && typeof r === 'object' && 'error' in (r as Record<string, unknown>);
                    span.setAttribute('axl.tool.success', !isError);
                    if (isError)
                      span.setStatus('error', (r as Record<string, unknown>).error as string);
                    return r;
                  },
                )
              : await executeOverride();

            const resultContent = JSON.stringify(toolResult);
            this.emitEvent({
              type: 'tool_call_end',
              agent: agent._name,
              tool: toolName,
              duration: Date.now() - toolStart,
              data: { args: toolArgs, result: toolResult, callId: toolCall.id },
            });
            currentMessages.push({
              role: 'tool',
              content: resultContent,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Find the tool (check local tools first, then MCP tools)
          const tool = agent._config.tools?.find((t) => t.name === toolName);
          const isMcpTool = !tool && this.mcpManager?.isMcpTool(toolName);

          if (!tool && !isMcpTool) {
            // Tool denied
            this.emitEvent({ type: 'tool_denied', agent: agent._name, tool: toolName });
            currentMessages.push({
              role: 'tool',
              content: `Tool "${toolName}" is not available. Available tools: ${agent._config.tools?.map((t) => t.name).join(', ') ?? 'none'}`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Parse tool arguments
          let toolArgs: unknown;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            currentMessages.push({
              role: 'tool',
              content: `Error: Invalid JSON in tool arguments. Please provide valid JSON.`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          this.emitEvent({
            type: 'tool_call_start',
            tool: toolName,
            callId: toolCall.id,
            data: { args: toolArgs },
          });
          this.onToolCall?.({ name: toolName, args: toolArgs, callId: toolCall.id }, callbackMeta);

          const toolStart = Date.now();

          // Approval gate: if tool requires approval, ask the human first.
          // Note: MCP tools have no `tool` object here (isMcpTool is true instead),
          // so they bypass the approval gate entirely. This is intentional — MCP tools
          // are externally managed and don't carry requireApproval config.
          if (tool && tool.requireApproval) {
            const approvalFn = async (): Promise<{ approved: boolean; reason?: string }> => {
              const decision = await this.awaitHuman({
                channel: 'tool_approval',
                prompt: `Tool "${toolName}" wants to execute with args: ${JSON.stringify(toolArgs)}`,
                metadata: { toolName, args: toolArgs, agent: agent._name },
              });
              if (!decision.approved) {
                const reason = decision.reason ?? 'Denied by human';
                currentMessages.push({
                  role: 'tool',
                  content: JSON.stringify({ error: `Tool denied by human: ${reason}` }),
                  tool_call_id: toolCall.id,
                });
                return { approved: false, reason };
              }
              return { approved: true };
            };

            let approvalOutcome: { approved: boolean; reason?: string };
            if (this.spanManager) {
              approvalOutcome = await this.spanManager.withSpanAsync(
                'axl.tool.approval',
                {
                  'axl.tool.name': toolName,
                  'axl.agent.name': agent._name,
                },
                async (span) => {
                  const result = await approvalFn();
                  span.setAttribute('axl.tool.approval.approved', result.approved);
                  return result;
                },
              );
            } else {
              approvalOutcome = await approvalFn();
            }

            this.emitEvent({
              type: 'tool_approval',
              agent: agent._name,
              tool: toolName,
              data: {
                approved: approvalOutcome.approved,
                args: toolArgs,
                ...(approvalOutcome.reason ? { reason: approvalOutcome.reason } : {}),
              },
            });

            if (!approvalOutcome.approved) continue;
          }

          // Before hook: transform input before execution
          if (tool && tool.hooks?.before) {
            try {
              toolArgs = await tool.hooks.before(toolArgs, this);
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              currentMessages.push({
                role: 'tool',
                content: JSON.stringify({ error: `Before hook error: ${errorMsg}` }),
                tool_call_id: toolCall.id,
              });
              continue;
            }
          }

          const executeTool = async (): Promise<{ toolResult: unknown; resultContent: string }> => {
            let toolResult: unknown;
            let resultContent: string;

            if (isMcpTool && this.mcpManager) {
              // Execute MCP tool
              try {
                const mcpResult = await this.mcpManager.callTool(toolName, toolArgs);
                toolResult = mcpResult;
                // Extract text content from MCP result
                resultContent = mcpResult.content
                  .map((c: { type: string; text?: string }) =>
                    c.type === 'text' ? c.text : `[${c.type}]`,
                  )
                  .join('\n');
                if (mcpResult.isError) {
                  resultContent = `Error: ${resultContent}`;
                }
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
                resultContent = JSON.stringify(toolResult);
              }
            } else if (tool) {
              // Execute local tool with a child context for nested agent invocations.
              // Pass toolCall.id so any nested trace events can be joined back
              // to this outer tool_call via `parentToolCallId`.
              const childCtx = this.createChildContext(toolCall.id);
              try {
                toolResult = await tool._execute(toolArgs, childCtx);
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
              }

              // After hook: transform output after execution (only on success)
              if (
                tool.hooks?.after &&
                !(
                  toolResult &&
                  typeof toolResult === 'object' &&
                  'error' in (toolResult as Record<string, unknown>)
                )
              ) {
                try {
                  toolResult = await tool.hooks.after(toolResult, this);
                } catch (err) {
                  toolResult = {
                    error: `After hook error: ${err instanceof Error ? err.message : String(err)}`,
                  };
                }
              }

              // Redact sensitive tool results
              resultContent = tool.sensitive
                ? '[REDACTED - sensitive tool output]'
                : JSON.stringify(toolResult);
            } else {
              toolResult = undefined;
              resultContent = 'Tool execution error';
            }

            return { toolResult, resultContent };
          };

          // Use qualified "server:tool_name" for MCP tools in traces
          const traceName =
            isMcpTool && this.mcpManager
              ? (this.mcpManager.getQualifiedName(toolName) ?? toolName)
              : toolName;

          const { toolResult, resultContent } = this.spanManager
            ? await this.spanManager.withSpanAsync(
                'axl.tool.call',
                {
                  'axl.tool.name': traceName,
                  'axl.agent.name': agent._name,
                },
                async (span) => {
                  const r = await executeTool();
                  span.setAttribute('axl.tool.duration', Date.now() - toolStart);
                  const isError =
                    r.toolResult &&
                    typeof r.toolResult === 'object' &&
                    'error' in (r.toolResult as Record<string, unknown>);
                  span.setAttribute('axl.tool.success', !isError);
                  if (isError)
                    span.setStatus(
                      'error',
                      (r.toolResult as Record<string, unknown>).error as string,
                    );
                  return r;
                },
              )
            : await executeTool();

          this.emitEvent({
            type: 'tool_call_end',
            agent: agent._name,
            tool: traceName,
            duration: Date.now() - toolStart,
            data: { args: toolArgs, result: toolResult, callId: toolCall.id },
          });

          currentMessages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: toolCall.id,
          });
        }

        continue; // Next turn
      }

      // No tool calls — we have the final response
      const content = response.content;

      // -- Gate 1: Output guardrail (raw text — content safety) --
      if (guardrails?.output) {
        const outputResult = await guardrails.output(content, { metadata: this.metadata });

        // Compute retry intent *before* emitting the trace so the feedback message
        // the LLM will see on its next attempt is visible in the same event.
        const attempt = guardrailOutputRetries + 1;
        const maxAttempts = maxGuardrailRetries + 1;
        const onBlock = guardrails.onBlock ?? 'throw';
        let feedbackMessage: string | undefined;
        if (
          outputResult.block &&
          onBlock === 'retry' &&
          guardrailOutputRetries < maxGuardrailRetries
        ) {
          feedbackMessage = `Your previous response was blocked by a safety guardrail: ${outputResult.reason ?? 'Output blocked'}. Please provide a different response that complies with the guidelines.`;
        }

        this.emitEvent({
          type: 'guardrail',
          agent: agent._name,
          data: {
            guardrailType: 'output',
            blocked: outputResult.block,
            ...(outputResult.reason ? { reason: outputResult.reason } : {}),
            attempt,
            maxAttempts,
            ...(feedbackMessage ? { feedbackMessage } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
          'axl.guardrail.type': 'output',
          'axl.guardrail.blocked': outputResult.block,
          'axl.guardrail.attempt': attempt,
          'axl.guardrail.maxAttempts': maxAttempts,
          ...(outputResult.reason ? { 'axl.guardrail.reason': outputResult.reason } : {}),
        });

        if (outputResult.block) {
          if (feedbackMessage) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'guardrail',
              attempt: guardrailOutputRetries + 1,
              maxAttempts: maxGuardrailRetries + 1,
              reason: feedbackMessage,
            });
            guardrailOutputRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              feedbackMessage,
              response.providerMetadata,
            );
            pendingRetryReason = 'guardrail';
            continue; // Re-enter the while loop for another LLM turn
          }
          if (typeof onBlock === 'function') {
            return onBlock(outputResult.reason ?? 'Output blocked by guardrail', {
              metadata: this.metadata,
            });
          }
          throw new GuardrailError('output', outputResult.reason ?? 'Output blocked by guardrail');
        }
      }

      // -- Gate 2: Schema validation (parse + Zod) --
      let validated: unknown = undefined;
      if (options?.schema) {
        const maxSchemaRetries = options.retries ?? 3;
        const schemaAttempt = schemaRetries + 1;
        const schemaMaxAttempts = maxSchemaRetries + 1;
        let schemaValid = false;
        let schemaReason: string | undefined;
        let schemaFeedback: string | undefined;
        let schemaErr: unknown;
        try {
          const parsed = JSON.parse(extractJson(content));
          validated = (options.schema as z.ZodType).parse(parsed);
          schemaValid = true;
        } catch (err) {
          schemaErr = err;
          schemaReason = err instanceof Error ? err.message : String(err);
          if (schemaRetries < maxSchemaRetries) {
            schemaFeedback = `Your response was not valid JSON or did not match the required schema: ${schemaReason}. Please fix and try again.`;
          }
        }

        this.emitEvent({
          type: 'schema_check',
          agent: agent._name,
          data: {
            valid: schemaValid,
            ...(schemaReason ? { reason: schemaReason } : {}),
            attempt: schemaAttempt,
            maxAttempts: schemaMaxAttempts,
            ...(schemaFeedback ? { feedbackMessage: schemaFeedback } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.schema.check', {
          'axl.schema.valid': schemaValid,
          'axl.schema.attempt': schemaAttempt,
          'axl.schema.maxAttempts': schemaMaxAttempts,
          ...(schemaReason ? { 'axl.schema.reason': schemaReason } : {}),
        });

        if (!schemaValid) {
          if (schemaFeedback) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'schema',
              attempt: schemaRetries + 1,
              maxAttempts: (options.retries ?? 3) + 1,
              reason: schemaFeedback,
            });
            schemaRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              schemaFeedback,
              response.providerMetadata,
            );
            pendingRetryReason = 'schema';
            continue; // Re-enter the while loop for another LLM turn
          }
          const zodErr =
            schemaErr instanceof ZodError
              ? schemaErr
              : new ZodError([
                  {
                    code: 'custom',
                    path: [],
                    message: schemaReason ?? 'Schema parse failed',
                  },
                ]);
          throw new VerifyError(content, zodErr, maxSchemaRetries);
        }
      }

      // -- Gate 3: Business rule validation (typed object) --
      // Only runs when both a schema and validate function are provided.
      // Without a schema, use output guardrails for raw text validation instead.
      if (options?.schema && options.validate) {
        // Wrap user-supplied validator in try/catch — treat exceptions as validation failures
        // so they get the same retry semantics instead of crashing the pipeline.
        let validateResult: ValidateResult;
        try {
          validateResult = await options.validate(validated, {
            metadata: this.metadata,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          validateResult = { valid: false, reason: `Validator error: ${reason}` };
        }

        const maxValidateRetries = options.validateRetries ?? 2;
        const validateAttempt = validateRetries + 1;
        const validateMaxAttempts = maxValidateRetries + 1;
        let validateFeedback: string | undefined;
        if (!validateResult.valid && validateRetries < maxValidateRetries) {
          validateFeedback = `Your response parsed correctly but failed validation: ${validateResult.reason ?? 'Validation failed'}. Previous attempts are visible above. Please fix and try again.`;
        }

        this.emitEvent({
          type: 'validate',
          agent: agent._name,
          data: {
            valid: validateResult.valid,
            ...(validateResult.reason ? { reason: validateResult.reason } : {}),
            attempt: validateAttempt,
            maxAttempts: validateMaxAttempts,
            ...(validateFeedback ? { feedbackMessage: validateFeedback } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.validate.check', {
          'axl.validate.valid': validateResult.valid,
          'axl.validate.attempt': validateAttempt,
          'axl.validate.maxAttempts': validateMaxAttempts,
          ...(validateResult.reason ? { 'axl.validate.reason': validateResult.reason } : {}),
        });

        if (!validateResult.valid) {
          if (validateFeedback) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'validate',
              attempt: validateRetries + 1,
              maxAttempts: (options.validateRetries ?? 2) + 1,
              reason: validateFeedback,
            });
            validateRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              validateFeedback,
              response.providerMetadata,
            );
            pendingRetryReason = 'validate';
            continue; // Re-enter the while loop — goes through all gates again
          }
          throw new ValidationError(
            validated,
            validateResult.reason ?? 'Validation failed',
            maxValidateRetries,
          );
        }
      }

      // All gates passed — emit pipeline `committed`, push to session
      // history, and return. Spec §4.2: terminal pipeline event for this
      // ask, fires before `done`.
      this.emitEvent({
        type: 'pipeline',
        agent: agent._name,
        status: 'committed',
        attempt: lastStartAttempt,
        maxAttempts: lastStartMaxAttempts,
      });
      this.pushAssistantToSessionHistory(content, response.providerMetadata);
      return validated ?? content;
    }

    throw new MaxTurnsError('ctx.ask()', maxTurns);
  }

  /**
   * Push the final assistant message into session history, preserving providerMetadata
   * (e.g., Gemini thought signatures needed for multi-turn reasoning context).
   */
  private pushAssistantToSessionHistory(
    content: string,
    providerMetadata?: Record<string, unknown>,
  ): void {
    this.sessionHistory.push({
      role: 'assistant',
      content,
      ...(providerMetadata ? { providerMetadata } : {}),
    });
  }

  private buildToolDefs(
    agent: Agent,
    resolvedHandoffs?: Array<{ agent: Agent; description?: string; mode?: 'oneway' | 'roundtrip' }>,
  ): ToolDefinition[] {
    const defs: ToolDefinition[] = [];

    if (agent._config.tools) {
      for (const tool of agent._config.tools) {
        defs.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.inputSchema),
          },
        });
      }
    }

    // Add handoff tools (already resolved by caller)
    if (resolvedHandoffs) {
      for (const { agent: handoffAgent, description, mode } of resolvedHandoffs) {
        const isRoundtrip = mode === 'roundtrip';
        const defaultDesc = isRoundtrip
          ? `Delegate a task to ${handoffAgent._name} and receive the result back`
          : `Hand off the conversation to ${handoffAgent._name}`;
        defs.push({
          type: 'function',
          function: {
            name: `handoff_to_${handoffAgent._name}`,
            description: description ?? defaultDesc,
            parameters: isRoundtrip
              ? {
                  type: 'object',
                  properties: { message: { type: 'string', description: 'The task to delegate' } },
                  required: ['message'],
                }
              : { type: 'object', properties: {} },
          },
        });
      }
    }

    // Add MCP tools
    if (this.mcpManager) {
      const mcpDefs = this.mcpManager.getToolDefinitions(agent._config.mcp, agent._config.mcpTools);
      defs.push(...mcpDefs);
    }

    return defs;
  }

  /**
   * Summarize old messages to fit within context window.
   * Keeps recent messages intact, summarizes older ones.
   */
  private async summarizeHistory(
    provider: Provider,
    model: string,
    history: ChatMessage[],
    availableTokens: number,
  ): Promise<ChatMessage[]> {
    // If we have a cached summary and the history hasn't grown much, reuse it
    if (this.summaryCache) {
      const summaryMsg: ChatMessage = {
        role: 'system',
        content: `Summary of earlier conversation:\n${this.summaryCache}`,
      };
      const summaryTokens = estimateTokens(summaryMsg.content) + 4;
      const remaining = availableTokens - summaryTokens;

      // Find how many recent messages fit
      let recentTokens = 0;
      let splitIdx = history.length;
      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(history[i].content) + 4;
        if (recentTokens + msgTokens > remaining) break;
        recentTokens += msgTokens;
        splitIdx = i;
      }

      if (splitIdx < history.length) {
        return [summaryMsg, ...history.slice(splitIdx)];
      }
    }

    // No cache or cache insufficient — generate a new summary
    // Find the split: keep as many recent messages as possible
    let recentTokens = 0;
    let splitIdx = history.length;
    const targetRecent = Math.floor(availableTokens * 0.6); // 60% for recent messages

    for (let i = history.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(history[i].content) + 4;
      if (recentTokens + msgTokens > targetRecent) break;
      recentTokens += msgTokens;
      splitIdx = i;
    }

    // If nothing to summarize (all messages are "recent"), just return all
    if (splitIdx === 0) return history;

    const oldMessages = history.slice(0, splitIdx);

    // Summarize old messages using the configured summary model or the same model
    const summaryModelUri = this.config.contextManagement?.summaryModel;
    let summaryProvider: Provider;
    let summaryModel: string;

    if (summaryModelUri) {
      const resolved = this.providerRegistry.resolve(summaryModelUri, this.config);
      summaryProvider = resolved.provider;
      summaryModel = resolved.model;
    } else {
      summaryProvider = provider;
      summaryModel = model;
    }

    const oldContent = oldMessages.map((m) => `${m.role}: ${m.content}`).join('\n');

    const summaryResponse = await summaryProvider.chat(
      [
        {
          role: 'system',
          content:
            'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation.',
        },
        { role: 'user', content: oldContent },
      ],
      { model: summaryModel, maxTokens: 1024, signal: this.currentSignal },
    );

    this.summaryCache = summaryResponse.content;

    // Persist summary cache to session metadata so it survives across requests
    const sessionId = this.metadata?.sessionId as string | undefined;
    if (sessionId && this.stateStore) {
      await this.stateStore.saveSessionMeta(sessionId, 'summaryCache', this.summaryCache);
    }

    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${summaryResponse.content}`,
    };

    return [summaryMsg, ...history.slice(splitIdx)];
  }

  // ── ctx.checkpoint() ────────────────────────────────────────────────

  /**
   * Execute a function with checkpoint-replay semantics.
   *
   * On first execution, runs `fn()`, saves the result, and returns it.
   * On replay (resume after restart), returns the saved result without re-executing.
   * This prevents duplicate side effects (double API calls, double refunds, etc.).
   */
  async checkpoint<T>(fn: () => Promise<T>): Promise<T> {
    return this._checkpoint(fn);
  }

  /**
   * Internal checkpoint implementation shared by both the public checkpoint()
   * and the automatic checkpointing in ask/spawn/race/parallel/map.
   */
  private async _checkpoint<T>(fn: () => Promise<T>): Promise<T> {
    const step = this.checkpointCounter++;

    // If no state store, just execute without persistence
    if (!this.stateStore) {
      return fn();
    }

    // Check for a saved checkpoint from a previous execution
    const saved = await this.stateStore.getCheckpoint(this.executionId, step);
    if (saved !== null) {
      this.emitEvent({
        type: 'log',
        data: { event: 'checkpoint_replay', step },
      });
      this.spanManager?.addEventToActiveSpan('axl.checkpoint.hit', { 'axl.checkpoint.step': step });
      return saved as T;
    }

    // Execute and save the result
    const result = await fn();

    await this.stateStore.saveCheckpoint(this.executionId, step, result);

    this.emitEvent({
      type: 'log',
      data: { event: 'checkpoint_save', step },
    });
    this.spanManager?.addEventToActiveSpan('axl.checkpoint.miss', { 'axl.checkpoint.step': step });

    return result;
  }

  // ── ctx.spawn() ───────────────────────────────────────────────────────

  async spawn<T>(
    n: number,
    fn: (index: number) => Promise<T>,
    options?: SpawnOptions,
  ): Promise<Result<T>[]> {
    return this._checkpoint(() => {
      if (this.spanManager) {
        return this.spanManager.withSpanAsync(
          'axl.ctx.spawn',
          {
            'axl.spawn.count': n,
            ...(options?.quorum != null ? { 'axl.spawn.quorum': options.quorum } : {}),
          },
          async (span) => {
            const results = await this._spawnImpl(n, fn, options);
            const completed = results.filter((r) => r !== undefined).length;
            const succeeded = results.filter((r) => r?.ok).length;
            span.setAttribute('axl.spawn.completed', completed);
            span.setAttribute('axl.spawn.succeeded', succeeded);
            span.setAttribute('axl.spawn.cancelled', n - completed);
            return results;
          },
        );
      }
      return this._spawnImpl(n, fn, options);
    });
  }

  private async _spawnImpl<T>(
    n: number,
    fn: (index: number) => Promise<T>,
    options?: SpawnOptions,
  ): Promise<Result<T>[]> {
    const results: Result<T>[] = [];
    let successCount = 0;
    const quorum = options?.quorum;

    if (quorum) {
      const controller = new AbortController();
      const parentSignal = this.currentSignal;
      const composedSignal = parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal;

      return new Promise<Result<T>[]>((resolve, reject) => {
        let settled = false;
        let completedCount = 0;

        for (let i = 0; i < n; i++) {
          const index = i;
          // Run each branch in an AsyncLocalStorage context with the composed signal
          const p = signalStorage.run(composedSignal, () => fn(index));

          p.then((value) => {
            if (settled) return;
            results[index] = { ok: true, value };
            successCount++;
            completedCount++;
            if (successCount >= quorum) {
              settled = true;
              controller.abort(); // Cancel remaining branches
              resolve(results);
            } else if (completedCount === n && successCount < quorum) {
              settled = true;
              reject(new QuorumNotMet(quorum, successCount, results));
            }
          }).catch((err) => {
            if (settled) return;
            // AbortErrors from our cancellation don't count as failures
            const isAbort = err instanceof DOMException && err.name === 'AbortError';
            if (isAbort) {
              completedCount++;
              if (completedCount === n && !settled && successCount < quorum) {
                settled = true;
                reject(new QuorumNotMet(quorum, successCount, results));
              }
              return;
            }
            results[index] = { ok: false, error: err instanceof Error ? err.message : String(err) };
            completedCount++;
            if (completedCount === n && successCount < quorum) {
              settled = true;
              reject(new QuorumNotMet(quorum, successCount, results));
            }
          });
        }
      });
    }

    // Default: run all, return all results
    const parentSignal = this.currentSignal;
    const promises = Array.from({ length: n }, (_, i) => {
      const run = () =>
        fn(i)
          .then((value): Result<T> => ({ ok: true, value }))
          .catch(
            (err): Result<T> => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      // Propagate parent signal so budget hard_stop can cancel non-quorum spawns
      return parentSignal ? signalStorage.run(parentSignal, run) : run();
    });

    return Promise.all(promises);
  }

  // ── ctx.vote() ────────────────────────────────────────────────────────

  vote<T>(results: Result<T>[], options: VoteOptions<T>): T | Promise<T> {
    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.vote',
        {
          'axl.vote.strategy': options.strategy,
          'axl.vote.candidates': results.filter((r) => r.ok).length,
        },
        async (span) => {
          const result = await this._voteImpl(results, options);
          span.setAttribute(
            'axl.vote.result',
            typeof result === 'object' ? JSON.stringify(result) : String(result),
          );
          return result;
        },
      );
    }
    return this._voteImpl(results, options);
  }

  private _voteImpl<T>(results: Result<T>[], options: VoteOptions<T>): T | Promise<T> {
    const successes = results
      .filter((r): r is Result<T> & { ok: true } => r.ok)
      .map((r) => r.value);

    if (successes.length === 0) {
      throw new NoConsensus('No successful results to vote on');
    }

    const { strategy, key, scorer, reducer } = options;

    if (scorer || (strategy === 'custom' && reducer)) {
      return this.asyncVote(successes, options);
    }

    switch (strategy) {
      case 'majority':
        return this.majorityVote(successes, key);
      case 'unanimous':
        return this.unanimousVote(successes, key);
      case 'highest':
        return this.numericVote(successes, key, 'highest');
      case 'lowest':
        return this.numericVote(successes, key, 'lowest');
      case 'mean':
        return this.meanVote(successes) as T;
      case 'median':
        return this.medianVote(successes) as T;
      case 'custom':
        if (reducer) return reducer(successes) as T;
        throw new NoConsensus('Custom strategy requires a reducer');
      default:
        throw new NoConsensus(`Unknown strategy: ${strategy}`);
    }
  }

  private async asyncVote<T>(successes: T[], options: VoteOptions<T>): Promise<T> {
    const { strategy, scorer, reducer } = options;

    if (strategy === 'custom' && reducer) {
      return reducer(successes);
    }

    if (scorer && (strategy === 'highest' || strategy === 'lowest')) {
      const scored = await Promise.all(
        successes.map(async (v) => ({ value: v, score: await scorer(v) })),
      );
      scored.sort((a, b) => (strategy === 'highest' ? b.score - a.score : a.score - b.score));
      return scored[0].value;
    }

    throw new NoConsensus(`Cannot use scorer with strategy "${strategy}"`);
  }

  private majorityVote<T>(values: T[], key?: string): T {
    const counts = new Map<string, { count: number; value: T }>();
    for (const v of values) {
      const k = key ? String((v as Record<string, unknown>)[key]) : JSON.stringify(v);
      const entry = counts.get(k);
      if (entry) entry.count++;
      else counts.set(k, { count: 1, value: v });
    }
    let best: { count: number; value: T } | undefined;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    return best!.value;
  }

  private unanimousVote<T>(values: T[], key?: string): T {
    const first = key ? (values[0] as Record<string, unknown>)[key] : JSON.stringify(values[0]);
    for (let i = 1; i < values.length; i++) {
      const current = key ? (values[i] as Record<string, unknown>)[key] : JSON.stringify(values[i]);
      if (String(current) !== String(first)) {
        throw new NoConsensus('Unanimous vote failed: values differ');
      }
    }
    return values[0];
  }

  private numericVote<T>(values: T[], key: string | undefined, mode: 'highest' | 'lowest'): T {
    let best = values[0];
    let bestVal = key ? Number((values[0] as Record<string, unknown>)[key]) : Number(values[0]);
    for (let i = 1; i < values.length; i++) {
      const val = key ? Number((values[i] as Record<string, unknown>)[key]) : Number(values[i]);
      if (mode === 'highest' ? val > bestVal : val < bestVal) {
        best = values[i];
        bestVal = val;
      }
    }
    return best;
  }

  private meanVote(values: unknown[]): number {
    const nums = values.map(Number);
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  private medianVote(values: unknown[]): number {
    const sorted = values.map(Number).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ── ctx.verify() ──────────────────────────────────────────────────────

  async verify<T>(
    fn: (retry?: VerifyRetry<T>) => Promise<unknown>,
    schema: z.ZodType<T>,
    options?: VerifyOptions<T>,
  ): Promise<T> {
    const maxRetries = options?.retries ?? 3;
    let lastRetry: VerifyRetry<T> | undefined = undefined;

    // Emits exactly one `verify` trace event at each terminal point so consumers
    // can see the outcome (pass/fail) and the number of attempts used. Called
    // just before every return/throw below; no-op on `continue`.
    const emitVerifyOutcome = (passed: boolean, attempts: number, lastError?: string) => {
      this.emitEvent({
        type: 'verify',
        agent: undefined,
        data: {
          passed,
          attempts,
          ...(lastError ? { lastError } : {}),
        },
      });
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let rawOutput: unknown;
      try {
        const result = await fn(lastRetry);
        rawOutput = result;
        const parsed = schema.parse(result) as T;

        // Post-schema business rule validation
        if (options?.validate) {
          let validateResult: ValidateResult;
          try {
            validateResult = await options.validate(parsed, { metadata: this.metadata });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            validateResult = { valid: false, reason: `Validator error: ${reason}` };
          }
          if (!validateResult.valid) {
            const errorMsg = validateResult.reason ?? 'Validation failed';
            lastRetry = { error: errorMsg, output: rawOutput, parsed };
            if (attempt === maxRetries) {
              emitVerifyOutcome(false, attempt + 1, errorMsg);
              if (options?.fallback !== undefined) return options.fallback;
              throw new ValidationError(parsed, errorMsg, maxRetries);
            }
            continue;
          }
        }

        emitVerifyOutcome(true, attempt + 1);
        return parsed;
      } catch (err) {
        if (err instanceof ValidationError) {
          // ValidationError from our own validate block or from fn (e.g., ctx.ask() validate
          // exhausted). Extract the parsed object so the next retry can repair it.
          // When fn() throws, rawOutput is undefined — fall back to the error's lastOutput.
          lastRetry = {
            error: err.reason,
            output: rawOutput ?? err.lastOutput,
            parsed: err.lastOutput as T,
          };
          if (attempt === maxRetries) {
            emitVerifyOutcome(false, attempt + 1, err.reason);
            if (options?.fallback !== undefined) return options.fallback;
            throw err;
          }
          continue;
        }

        // VerifyError from fn (e.g., ctx.ask() with schema exhausted retries, or nested
        // ctx.verify()). Extract lastOutput so fn can attempt repair — output is the raw
        // LLM response that failed parsing, parsed stays undefined.
        if (err instanceof VerifyError) {
          lastRetry = { error: err.message, output: rawOutput ?? err.lastOutput };
          if (attempt === maxRetries) {
            emitVerifyOutcome(false, attempt + 1, err.message);
            if (options?.fallback !== undefined) return options.fallback;
            throw err;
          }
          continue;
        }

        const errorMsg =
          err instanceof ZodError ? err.message : err instanceof Error ? err.message : String(err);
        lastRetry = { error: errorMsg, output: rawOutput };

        if (attempt === maxRetries) {
          emitVerifyOutcome(false, attempt + 1, errorMsg);
          if (options?.fallback !== undefined) return options.fallback;
          const zodErr =
            err instanceof ZodError
              ? err
              : new ZodError([{ code: 'custom', path: [], message: errorMsg }]);
          throw new VerifyError(rawOutput, zodErr, maxRetries);
        }
      }
    }

    emitVerifyOutcome(false, maxRetries + 1, lastRetry?.error ?? 'Verify failed');
    if (options?.fallback !== undefined) return options.fallback;
    throw new VerifyError(
      lastRetry?.output,
      new ZodError([{ code: 'custom', path: [], message: 'Verify failed' }]),
      maxRetries,
    );
  }

  // ── ctx.budget() ──────────────────────────────────────────────────────

  async budget<T>(options: BudgetOptions, fn: () => Promise<T>): Promise<BudgetResult<T>> {
    const limit = parseCost(options.cost);
    const policy = options.onExceed ?? 'finish_and_stop';

    const parentBudget = this.budgetContext;
    const controller = policy === 'hard_stop' ? new AbortController() : undefined;
    const parentSignal = this.currentSignal;

    const budgetSignal = controller
      ? parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal
      : undefined;

    this.budgetContext = {
      totalCost: 0,
      limit,
      exceeded: false,
      policy,
      abortController: controller,
    };

    const executeBudget = async (): Promise<BudgetResult<T>> => {
      try {
        // Run fn in an AsyncLocalStorage context with the budget signal
        const value = budgetSignal ? await signalStorage.run(budgetSignal, fn) : await fn();
        const totalCost = this.budgetContext!.totalCost;
        const exceeded = this.budgetContext!.exceeded;
        return { value, budgetExceeded: exceeded, totalCost };
      } catch (err) {
        if (this.budgetContext!.exceeded) {
          return { value: null, budgetExceeded: true, totalCost: this.budgetContext!.totalCost };
        }
        // AbortError from hard_stop should count as budget exceeded
        if (err instanceof DOMException && err.name === 'AbortError' && controller) {
          return { value: null, budgetExceeded: true, totalCost: this.budgetContext!.totalCost };
        }
        throw err;
      } finally {
        if (parentBudget) parentBudget.totalCost += this.budgetContext!.totalCost;
        this.budgetContext = parentBudget;
      }
    };

    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.budget',
        {
          'axl.budget.limit': limit,
          'axl.budget.policy': policy,
        },
        async (span) => {
          const result = await executeBudget();
          span.setAttribute('axl.budget.totalCost', result.totalCost);
          span.setAttribute('axl.budget.exceeded', result.budgetExceeded);
          return result;
        },
      );
    }

    return executeBudget();
  }

  /** Get the current budget status, or null if not inside a budget block. */
  getBudgetStatus(): { spent: number; limit: number; remaining: number } | null {
    if (!this.budgetContext) return null;
    return {
      spent: this.budgetContext.totalCost,
      limit: this.budgetContext.limit,
      remaining: Math.max(0, this.budgetContext.limit - this.budgetContext.totalCost),
    };
  }

  // ── ctx.race() ────────────────────────────────────────────────────────

  async race<T>(fns: Array<() => Promise<T>>, options?: RaceOptions<T>): Promise<T> {
    return this._checkpoint(() => {
      if (this.spanManager) {
        return this.spanManager.withSpanAsync(
          'axl.ctx.race',
          {
            'axl.race.participants': fns.length,
          },
          async (span) => {
            let winnerIndex = -1;
            const wrappedFns = fns.map((fn, i) => async () => {
              const result = await fn();
              winnerIndex = i;
              return result;
            });
            const result = await this._raceImpl(wrappedFns, options);
            span.setAttribute('axl.race.resolved', true);
            span.setAttribute('axl.race.winner', winnerIndex);
            return result;
          },
        );
      }
      return this._raceImpl(fns, options);
    });
  }

  private async _raceImpl<T>(fns: Array<() => Promise<T>>, options?: RaceOptions<T>): Promise<T> {
    const controller = new AbortController();
    let lastError: Error | undefined;
    const schema = options?.schema as z.ZodType | undefined;

    const parentSignal = this.currentSignal;
    const composedSignal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let remaining = fns.length;

      for (const fn of fns) {
        // Run each branch in an AsyncLocalStorage context with the composed signal.
        // This ensures the signal persists through all awaits in the branch.
        const p = signalStorage.run(composedSignal, fn);

        p.then(async (value) => {
          if (settled) return;
          // If a schema is provided, validate the result.
          // Invalid results are discarded and the race continues.
          if (schema) {
            const parsed = schema.safeParse(value);
            if (!parsed.success) {
              remaining--;
              lastError = new Error(`Schema validation failed: ${parsed.error.message}`);
              if (remaining === 0 && !settled) {
                settled = true;
                reject(lastError);
              }
              return;
            }
            // Post-schema business rule validation — invalid results discarded like schema failures
            if (options?.validate) {
              try {
                const validateResult = await options.validate(parsed.data as T, {
                  metadata: this.metadata,
                });
                if (!validateResult.valid) {
                  remaining--;
                  lastError = new Error(
                    `Validation failed: ${validateResult.reason ?? 'Validation failed'}`,
                  );
                  if (remaining === 0 && !settled) {
                    settled = true;
                    reject(lastError);
                  }
                  return;
                }
              } catch (err) {
                remaining--;
                lastError =
                  err instanceof Error ? err : new Error(`Validator error: ${String(err)}`);
                if (remaining === 0 && !settled) {
                  settled = true;
                  reject(lastError);
                }
                return;
              }
            }
            if (settled) return; // another branch may have won during async validate
            settled = true;
            controller.abort();
            resolve(parsed.data as T);
            return;
          }
          settled = true;
          controller.abort(); // Cancel losing branches
          resolve(value);
        }).catch((err) => {
          if (settled) return;
          // Ignore AbortErrors from our own cancellation
          if (err instanceof DOMException && err.name === 'AbortError') {
            remaining--;
            if (remaining === 0 && !settled) {
              settled = true;
              reject(lastError ?? new Error('All race branches were aborted'));
            }
            return;
          }
          remaining--;
          lastError = err instanceof Error ? err : new Error(String(err));
          if (remaining === 0 && !settled) {
            settled = true;
            reject(lastError);
          }
        });
      }
    });
  }

  // ── ctx.parallel() ────────────────────────────────────────────────────

  async parallel<T extends unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
    return this._checkpoint(() => Promise.all(fns.map((fn) => fn())) as Promise<T>);
  }

  // ── ctx.map() ─────────────────────────────────────────────────────────

  async map<T, U>(
    items: T[],
    fn: (item: T, index: number) => Promise<U>,
    options?: MapOptions,
  ): Promise<Result<U>[]> {
    return this._checkpoint(() => this._mapImpl(items, fn, options));
  }

  private async _mapImpl<T, U>(
    items: T[],
    fn: (item: T, index: number) => Promise<U>,
    options?: MapOptions,
  ): Promise<Result<U>[]> {
    const concurrency = options?.concurrency ?? 5;
    const quorum = options?.quorum;
    const results: Result<U>[] = new Array(items.length);
    let nextIndex = 0;
    let successCount = 0;
    let completedCount = 0;
    let settled = false;

    const controller = quorum ? new AbortController() : undefined;
    const parentSignal = this.currentSignal;
    const mapSignal = controller
      ? parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal
      : parentSignal;

    return new Promise<Result<U>[]>((resolve, reject) => {
      if (items.length === 0) {
        resolve([]);
        return;
      }

      const runNext = async () => {
        while (nextIndex < items.length && !settled) {
          const idx = nextIndex++;
          try {
            // Run each item in an AsyncLocalStorage context with the map signal
            const value = mapSignal
              ? await signalStorage.run(mapSignal, () => fn(items[idx], idx))
              : await fn(items[idx], idx);
            results[idx] = { ok: true, value };
            successCount++;
          } catch (err) {
            // Ignore AbortErrors from our own quorum cancellation
            if (
              err instanceof DOMException &&
              err.name === 'AbortError' &&
              controller?.signal.aborted
            ) {
              completedCount++;
              return;
            }
            results[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          completedCount++;

          if (quorum && successCount >= quorum) {
            settled = true;
            controller?.abort(); // Cancel remaining work
            resolve(results);
            return;
          }

          if (completedCount === items.length) {
            if (quorum && successCount < quorum) {
              reject(new QuorumNotMet(quorum, successCount, results));
            } else {
              resolve(results);
            }
            return;
          }
        }
      };

      const workers = Math.min(concurrency, items.length);
      for (let i = 0; i < workers; i++) {
        runNext().catch((err) => {
          if (!settled) reject(err);
        });
      }
    });
  }

  // ── ctx.awaitHuman() ──────────────────────────────────────────────────

  async awaitHuman(options: AwaitHumanOptions): Promise<HumanDecision> {
    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.awaitHuman',
        {
          'axl.awaitHuman.channel': options.channel,
        },
        async (span) => {
          const start = Date.now();
          const result = await this._awaitHumanImpl(options);
          span.setAttribute('axl.awaitHuman.wait_duration', Date.now() - start);
          span.setAttribute('axl.awaitHuman.approved', result.approved);
          return result;
        },
      );
    }
    return this._awaitHumanImpl(options);
  }

  private async _awaitHumanImpl(options: AwaitHumanOptions): Promise<HumanDecision> {
    if (this.awaitHumanHandler) {
      const decision = await this.awaitHumanHandler(options);
      this.emitEvent({
        type: 'log',
        data: { event: 'await_human_resolved', channel: options.channel, decision },
      });
      return decision;
    }

    if (!this.pendingDecisions) {
      throw new Error(
        'Tool requires approval but no approval handler is configured. ' +
          'Provide awaitHumanHandler to createContext() or use runtime.execute() with workflow infrastructure.',
      );
    }

    if (this.stateStore) {
      await this.stateStore.savePendingDecision(this.executionId, {
        executionId: this.executionId,
        channel: options.channel,
        prompt: options.prompt,
        metadata: options.metadata,
        createdAt: new Date().toISOString(),
      });

      // Persist execution state so we can resume after restart
      await this.stateStore.saveExecutionState(this.executionId, {
        workflow: this.workflowName ?? 'unknown',
        input: this.input,
        step: this.stepRefRoot.value,
        status: 'waiting',
        metadata: {
          ...this.metadata,
          awaitHumanChannel: options.channel,
          awaitHumanPrompt: options.prompt,
        },
      });
    }

    this.emitEvent({
      type: 'log',
      data: { event: 'await_human', channel: options.channel, prompt: options.prompt },
    });

    const decision = await new Promise<HumanDecision>((resolve) => {
      this.pendingDecisions!.set(this.executionId, resolve);
    });

    // Update execution state to running after decision is received
    if (this.stateStore) {
      await this.stateStore.saveExecutionState(this.executionId, {
        workflow: this.workflowName ?? 'unknown',
        input: this.input,
        step: this.stepRefRoot.value,
        status: 'running',
      });
    }

    return decision;
  }

  /**
   * Compose an `AbortSignal` for a memory operation's underlying embedder
   * fetch. Combines the parent context signal (user cancellation,
   * `runtime.execute({ signal })`) with the budget hard_stop abort so
   * that either cause correctly aborts an in-flight embed call.
   *
   * Returns `undefined` if there's nothing to cancel on — the embedder
   * runs without a signal in that case, matching its prior behavior.
   *
   * @internal
   */
  private _composeMemorySignal(): AbortSignal | undefined {
    const budgetSignal = this.budgetContext?.abortController?.signal;
    if (this.signal && budgetSignal) return AbortSignal.any([this.signal, budgetSignal]);
    return this.signal ?? budgetSignal;
  }

  /**
   * Accumulate a cost amount into the active `budgetContext` and trip the
   * `exceeded` flag if we've crossed the limit. On `hard_stop` policy,
   * also fires the abort controller so in-flight operations cancel.
   *
   * Called from every code path that spends money: the `agent_call` loop,
   * semantic memory operations (`ctx.remember({embed:true})`, `ctx.recall({query})`),
   * and any future cost-emitting primitive. Centralizing the logic here
   * means `ctx.budget({ limit, policy })` accurately enforces the limit
   * across ALL cost sources — not just agent calls.
   *
   * @internal
   */
  private _accumulateBudgetCost(amount: number): void {
    if (!this.budgetContext) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.budgetContext.totalCost += amount;
    if (this.budgetContext.totalCost >= this.budgetContext.limit) {
      this.budgetContext.exceeded = true;
      // hard_stop: abort current in-flight operations immediately
      if (this.budgetContext.policy === 'hard_stop' && this.budgetContext.abortController) {
        this.budgetContext.abortController.abort();
      }
    }
  }

  // ── workflow lifecycle trace emission ──────────────────────────────────
  //
  // These are called by the runtime at execution boundaries. They emit
  // first-class `workflow_start` / `workflow_end` trace events instead of
  // the previous `ctx.log('workflow_start', ...)` indirection — so consumers
  // that narrow via `event.type === 'workflow_start'` actually see them.
  // Internal: the runtime is the only caller, user workflows never call these.

  /** @internal */
  _emitWorkflowStart(input: unknown): void {
    this.emitEvent({
      type: 'workflow_start',
      workflow: this.workflowName,
      data: { input },
    });
  }

  /** @internal */
  _emitWorkflowEnd(info: {
    status: 'completed' | 'failed';
    duration: number;
    result?: unknown;
    error?: string;
    aborted?: boolean;
  }): void {
    this.emitEvent({
      type: 'workflow_end',
      workflow: this.workflowName,
      duration: info.duration,
      data: {
        status: info.status,
        duration: info.duration,
        ...(info.result !== undefined ? { result: info.result } : {}),
        ...(info.error !== undefined ? { error: info.error } : {}),
        ...(info.aborted ? { aborted: true } : {}),
      },
    });
  }

  // ── ctx.log() ─────────────────────────────────────────────────────────

  log(event: string, data?: unknown): void {
    this.emitEvent({
      type: 'log',
      data: {
        event,
        ...(data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : data !== undefined
            ? { value: data }
            : {}),
      },
    });

    // Forward log events to the active OTel span
    if (this.spanManager) {
      const attrs: Record<string, string | number | boolean> = { 'axl.log.event': event };
      if (data !== undefined && typeof data === 'object' && data !== null) {
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            attrs[`axl.log.${k}`] = v;
          }
        }
      }
      this.spanManager.addEventToActiveSpan('axl.log', attrs);
    }
  }

  // -- ctx.remember() / ctx.recall() ----------------------------------------

  /**
   * Store a value in memory, scoped to the current session (default) or globally.
   * When a vector store is configured, the value is also embedded for semantic recall.
   */
  async remember(key: string, value: unknown, options?: RememberOptions): Promise<void> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    // Budget gate: refuse to start a new memory op if the budget has
    // already been breached. Semantic remember hits a paid embedding API
    // and without this check a hard_stop budget only stopped the next
    // `ctx.ask()` call — memory writes could keep spending after the
    // limit. Mirrors the gate at the top of `ctx.ask()`.
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy !== 'warn') {
        throw new BudgetExceededError(limit, spent, policy);
      }
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    // Operation-only audit trail — values are deliberately NOT traced because
    // they can be arbitrary user data. Emit on both success and failure so
    // compliance consumers can reconstruct the full audit history even when
    // the underlying store rejects the write.
    try {
      const memorySignal = this._composeMemorySignal();
      const { usage } = await this.memoryManager.remember(
        key,
        value,
        this.stateStore,
        sessionId,
        options,
        memorySignal,
      );
      // Budget attribution: embedder spend counts against `ctx.budget()`
      // the same way agent_call cost does. Without this, a RAG workload
      // with heavy semantic memory can silently breach a hard_stop
      // budget (memory cost was previously only flowing through the
      // trace-event rail for trackExecution, bypassing budgetContext).
      if (usage?.cost != null) {
        this._accumulateBudgetCost(usage.cost);
      }
      // Surface embedder cost at the AxlEvent top level so the
      // `trackExecution` listener picks it up automatically (it sums
      // `event.cost` across every event in scope, regardless of type).
      // Also mirror `usage.tokens` to top-level `tokens.input` so the
      // CostAggregator's early-return gate (`cost == null && !tokens`)
      // doesn't silently drop zero-cost-but-nonzero-token events from a
      // local embedder or an unknown-pricing model. Tokens live in
      // `tokens.input` because embedding APIs bill on input only.
      // `usage` is also nested into the event `data` for trace-explorer
      // visibility (debuggers see the full model/cost/tokens breakdown).
      this.emitEvent({
        type: 'memory_remember',
        ...(usage?.cost != null ? { cost: usage.cost } : {}),
        ...(usage?.tokens != null ? { tokens: { input: usage.tokens } } : {}),
        data: {
          key,
          scope,
          embed: options?.embed === true,
          ...(usage ? { usage } : {}),
        },
      });
    } catch (err) {
      // Recover cost attribution on the partial-failure path: if the
      // embedder call succeeded but a downstream step (vectorStore.upsert)
      // failed, `MemoryManager.remember` attaches the usage to the error
      // as a non-enumerable `axlEmbedUsage` property. The user has already
      // been billed for the embed — we owe them accurate cost tracking
      // even though the memory write ultimately failed (including budget
      // accounting, so a partial-failure RAG burst still counts against
      // a hard_stop budget).
      const partialUsage = (err as { axlEmbedUsage?: import('./memory/types.js').EmbedUsage })
        .axlEmbedUsage;
      if (partialUsage?.cost != null) {
        this._accumulateBudgetCost(partialUsage.cost);
      }
      this.emitEvent({
        type: 'memory_remember',
        ...(partialUsage?.cost != null ? { cost: partialUsage.cost } : {}),
        ...(partialUsage?.tokens != null ? { tokens: { input: partialUsage.tokens } } : {}),
        data: {
          key,
          scope,
          embed: options?.embed === true,
          ...(partialUsage ? { usage: partialUsage } : {}),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Recall a value from memory by key, or perform semantic search if query option is provided.
   */
  async recall(key: string, options?: RecallOptions): Promise<unknown | VectorResult[] | null> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    // Budget gate: refuse to start a new semantic recall if the budget
    // has already been breached. See ctx.remember for rationale.
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy !== 'warn') {
        throw new BudgetExceededError(limit, spent, policy);
      }
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    const semantic = options?.query !== undefined;
    // Operation-only audit trail. Emit on both success and failure.
    try {
      const memorySignal = this._composeMemorySignal();
      const { data, usage } = await this.memoryManager.recall(
        key,
        this.stateStore,
        sessionId,
        options,
        memorySignal,
      );
      let hit: boolean;
      let resultCount: number | undefined;
      if (semantic) {
        resultCount = Array.isArray(data) ? data.length : 0;
        hit = resultCount > 0;
      } else {
        hit = data !== null && data !== undefined;
      }
      // Budget attribution: semantic recall embedder cost counts against
      // `ctx.budget()`. Heavy RAG read workloads could previously breach
      // a hard_stop budget silently — memory cost flowed through the trace
      // rail for trackExecution but bypassed budgetContext.
      if (usage?.cost != null) {
        this._accumulateBudgetCost(usage.cost);
      }
      // Surface embedder cost + tokens at the AxlEvent top level so
      // the `trackExecution` listener picks cost up and the CostAggregator's
      // early-return gate (`cost == null && !tokens`) doesn't silently
      // drop zero-cost-but-nonzero-token events. `usage` is also nested
      // into `data.usage` for trace inspection.
      this.emitEvent({
        type: 'memory_recall',
        ...(usage?.cost != null ? { cost: usage.cost } : {}),
        ...(usage?.tokens != null ? { tokens: { input: usage.tokens } } : {}),
        data: {
          key,
          scope,
          semantic,
          hit,
          ...(resultCount !== undefined ? { resultCount, count: resultCount } : {}),
          ...(usage ? { usage } : {}),
        },
      });
      return data;
    } catch (err) {
      this.emitEvent({
        type: 'memory_recall',
        data: {
          key,
          scope,
          semantic,
          hit: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /** Delete a memory entry by key. */
  async forget(key: string, options?: { scope?: 'session' | 'global' }): Promise<void> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    try {
      await this.memoryManager.forget(key, this.stateStore, sessionId, options);
      this.emitEvent({
        type: 'memory_forget',
        data: { key, scope },
      });
    } catch (err) {
      this.emitEvent({
        type: 'memory_forget',
        data: {
          key,
          scope,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  // ── ctx.delegate() ──────────────────────────────────────────────────

  /**
   * Select the best agent from a list of candidates and invoke it.
   * Creates a temporary router agent that uses handoffs to pick the right specialist.
   *
   * This is convenience sugar over creating a router agent with dynamic handoffs.
   * For full control over the router's behavior, create the router agent explicitly.
   *
   * @param agents - Candidate agents to choose from (at least 1)
   * @param prompt - The prompt to send to the selected agent
   * @param options - Optional: schema, routerModel, metadata, retries
   */
  async delegate<T = string>(
    agents: Agent[],
    prompt: string,
    options?: DelegateOptions<T>,
  ): Promise<T> {
    if (agents.length === 0) {
      throw new Error('ctx.delegate() requires at least one candidate agent');
    }

    // Validate no duplicate agent names — duplicates produce duplicate tool names
    // which violates LLM API contracts and makes the second agent unreachable.
    const names = new Set<string>();
    for (const a of agents) {
      if (names.has(a._name)) {
        throw new Error(
          `ctx.delegate() received duplicate agent name '${a._name}'. All candidate agents must have unique names.`,
        );
      }
      names.add(a._name);
    }

    if (agents.length === 1) {
      this.emitEvent({
        type: 'delegate',
        agent: agents[0]._name,
        data: {
          candidates: [agents[0]._name],
          selected: agents[0]._name,
          reason: 'single_candidate',
        },
      });
      return this.ask(agents[0], prompt, {
        schema: options?.schema,
        retries: options?.retries,
        metadata: options?.metadata,
        validate: options?.validate,
        validateRetries: options?.validateRetries,
      });
    }

    // Resolve the router model: explicit option > first candidate's model
    const resolveCtx = options?.metadata
      ? { metadata: { ...this.metadata, ...options.metadata } }
      : { metadata: this.metadata };
    const routerModelUri = options?.routerModel ?? agents[0].resolveModel(resolveCtx);

    // Build handoff descriptors from candidates.
    // Use the agent's system prompt (truncated) as the handoff description
    // so the router LLM understands each candidate's capability.
    const handoffs = agents.map((a) => {
      let description: string;
      try {
        description = a.resolveSystem(resolveCtx).slice(0, 200);
      } catch {
        description = `Agent: ${a._name}`;
      }
      return { agent: a, description };
    });

    const routerSystem =
      'Route to the best agent for this task. Always hand off; never answer directly.';

    // Create a temporary router agent (inline to avoid circular import with agent.ts).
    // maxTurns: 2 allows one turn for the LLM to pick a handoff, plus one retry
    // if the first response is text instead of a tool call.
    const routerAgent: Agent = {
      _config: {
        model: routerModelUri,
        system: routerSystem,
        temperature: 0,
        handoffs,
        maxTurns: 2,
      },
      _name: '_delegate_router',
      ask: async () => {
        throw new Error('Direct invocation not supported on delegate router');
      },
      resolveModel: () => routerModelUri,
      resolveSystem: () => routerSystem,
    };

    this.emitEvent({
      type: 'delegate',
      agent: '_delegate_router',
      data: {
        candidates: agents.map((a) => a._name),
        routerModel: routerModelUri,
        reason: 'routed',
      },
    });

    return this.ask(routerAgent, prompt, {
      schema: options?.schema,
      retries: options?.retries,
      metadata: options?.metadata,
      validate: options?.validate,
      validateRetries: options?.validateRetries,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────

  /**
   * Internal emitter input — intentionally loose so call sites don't need to
   * build a perfectly-narrowed discriminated-union member. The resulting
   * `AxlEvent` (exported type) remains strict, and TypeScript narrows it at
   * consumer sites via the `type` discriminator.
   */
  private emitEvent(partial: {
    type: AxlEvent['type'];
    workflow?: string;
    agent?: string;
    tool?: string;
    promptVersion?: string;
    model?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number };
    duration?: number;
    data?: unknown;
    // Variant-specific fields are accepted as `unknown`-typed extras so
    // call sites don't need to build a perfectly-narrowed discriminated
    // union member. The final `as unknown as AxlEvent` cast at the bottom
    // of the function is the runtime contract — emit sites are
    // responsible for pairing `type` with the matching variant fields.
    [key: string]: unknown;
  }): void {
    // Top-level redaction for variants whose user/LLM payload sits outside
    // `data` (e.g. `ask_start.prompt`, `ask_end.outcome.{result,error}`).
    // Mutates `partial` in place — done before the `data`-branch redactor
    // below to keep the two paths independent.
    if (this.config.trace?.redact) {
      if (partial.type === 'ask_start' && typeof partial.prompt === 'string') {
        partial.prompt = '[redacted]';
      } else if (partial.type === 'ask_end') {
        const outcome = partial.outcome as
          | { ok: true; result: unknown }
          | { ok: false; error: string }
          | undefined;
        if (outcome?.ok) {
          partial.outcome = { ok: true, result: '[redacted]' };
        } else if (outcome) {
          partial.outcome = { ok: false, error: '[redacted]' };
        }
      }
    }
    let data: unknown = partial.data;
    if (this.config.trace?.redact && data) {
      // Redact any field that can carry prompt/response/PII content. Structural
      // fields (attempt, maxAttempts, params, turn, valid, blocked, etc.) are
      // left visible so traces remain useful for debugging and observability.
      // Redaction preserves the original field shape — strings become
      // '[redacted]' strings, `messages` stays a `ChatMessage[]` (single stub
      // entry preserving the count) — so downstream consumers can narrow
      // types without special-casing redacted vs non-redacted events.
      if (partial.type === 'agent_call_end') {
        const d = data as Record<string, unknown>;
        const redacted: Record<string, unknown> = {
          ...d,
          prompt: '[redacted]',
          response: '[redacted]',
        };
        if (d.system !== undefined) redacted.system = '[redacted]';
        if (d.thinking !== undefined) redacted.thinking = '[redacted]';
        if (Array.isArray(d.messages)) {
          redacted.messages = [
            { role: 'system', content: `[${d.messages.length} messages redacted]` },
          ];
        }
        data = redacted;
      } else if (
        partial.type === 'guardrail' ||
        partial.type === 'schema_check' ||
        partial.type === 'validate'
      ) {
        const d = data as Record<string, unknown>;
        // `reason` can trivially echo user input (e.g. "Value 'john@acme.com'
        // is not a valid email") — redact it alongside `feedbackMessage`.
        const needsRedact = d.feedbackMessage !== undefined || d.reason !== undefined;
        if (needsRedact) {
          data = {
            ...d,
            ...(d.reason !== undefined ? { reason: '[redacted]' } : {}),
            ...(d.feedbackMessage !== undefined ? { feedbackMessage: '[redacted]' } : {}),
          };
        }
      } else if (partial.type === 'tool_call_start') {
        // Pre-execution args carry the same user PII as the post-execution
        // tool_call_end. Scrub at emit time so direct `runtime.on('trace')`
        // consumers and `ExecutionInfo.events` reads don't leak them.
        const d = data as Record<string, unknown>;
        data = { ...d, args: '[redacted]' };
      } else if (partial.type === 'tool_call_end') {
        // Tool args can carry user PII ("lookup SSN: 123-45-6789"), tool
        // results can carry full records from internal systems. Redact both
        // when the global trace.redact policy is on; callId stays visible so
        // consumers can still correlate with other events in the stream.
        const d = data as Record<string, unknown>;
        data = {
          ...d,
          args: '[redacted]',
          result: '[redacted]',
        };
      } else if (partial.type === 'tool_denied') {
        // The LLM named a tool the agent doesn't expose. `args` and `reason`
        // can echo user intent verbatim.
        const d = (data ?? {}) as Record<string, unknown>;
        data = {
          ...d,
          ...(d.args !== undefined ? { args: '[redacted]' } : {}),
          ...(d.reason !== undefined ? { reason: '[redacted]' } : {}),
        };
      } else if (partial.type === 'partial_object') {
        // Progressive structured-output snapshots carry the same payload
        // as the final result — same PII surface. Stream-only, but still
        // flows through `onTrace` to any direct subscriber.
        const d = data as Record<string, unknown>;
        if (d.object !== undefined) {
          data = { ...d, object: '[redacted]' };
        }
      } else if (partial.type === 'verify') {
        // `lastError` echoes the verify predicate's failure message, which
        // often quotes the LLM's output (the same text that's scrubbed on
        // agent_call_end).
        const d = data as Record<string, unknown>;
        if (d.lastError !== undefined) {
          data = { ...d, lastError: '[redacted]' };
        }
      } else if (partial.type === 'pipeline') {
        // Only the `failed` status carries `reason` (the feedback message
        // about to be injected into the conversation — quotes LLM output).
        // Mutate the top-level field in-place; pipeline events don't use
        // `data` for the reason.
        if ((partial as { status?: string }).status === 'failed') {
          (partial as Record<string, unknown>).reason = '[redacted]';
        }
      } else if (partial.type === 'tool_approval') {
        const d = data as Record<string, unknown>;
        data = {
          ...d,
          args: '[redacted]',
          ...(d.reason !== undefined ? { reason: '[redacted]' } : {}),
        };
      } else if (partial.type === 'handoff') {
        // `message` on roundtrip handoffs is user-supplied content. `target`,
        // `source`, `mode`, `duration` are structural — keep visible.
        const d = data as Record<string, unknown>;
        if (d.message !== undefined) {
          data = { ...d, message: '[redacted]' };
        }
      } else if (partial.type === 'workflow_start') {
        // `input` is the user-supplied workflow input. Scrub it; keep shape so
        // consumers can still detect the event. Structural fields (executionId
        // on the parent event, workflow name) remain visible.
        const d = data as Record<string, unknown>;
        if (d.input !== undefined) {
          data = { ...d, input: '[redacted]' };
        }
      } else if (partial.type === 'workflow_end') {
        // `result` is the workflow return value, `error` is the thrown error
        // message — both can echo user data (e.g., Zod error messages from
        // outputSchema.parse failures quote the offending user value). Status,
        // duration, and `aborted` are structural — keep visible.
        const d = data as Record<string, unknown>;
        const redacted: Record<string, unknown> = { ...d };
        if (d.result !== undefined) redacted.result = '[redacted]';
        if (d.error !== undefined) redacted.error = '[redacted]';
        data = redacted;
      } else if (
        partial.type === 'memory_remember' ||
        partial.type === 'memory_recall' ||
        partial.type === 'memory_forget'
      ) {
        // Memory-event data fields can carry PII (`key` may echo user
        // input like "user:john@x.com"; `scope` may encode tenant ids;
        // `usage.model` may expose the embedder URI). Conservative
        // redaction: scrub all string fields; preserve numeric/boolean
        // fields (load-bearing for the Cost Dashboard's byEmbedder
        // bucket + trace-explorer row metadata). One-level object walk
        // mirrors the legacy `log`-branch policy so `usage.tokens` and
        // `usage.cost` stay visible while `usage.model` is scrubbed.
        const d = data as Record<string, unknown>;
        const redacted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(d)) {
          if (typeof v === 'number' || typeof v === 'boolean') {
            redacted[k] = v;
          } else if (typeof v === 'string') {
            redacted[k] = '[redacted]';
          } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const inner = v as Record<string, unknown>;
            const innerRedacted: Record<string, unknown> = {};
            for (const [ik, iv] of Object.entries(inner)) {
              if (typeof iv === 'number' || typeof iv === 'boolean') {
                innerRedacted[ik] = iv;
              } else {
                innerRedacted[ik] = '[redacted]';
              }
            }
            redacted[k] = innerRedacted;
          } else {
            redacted[k] = '[redacted]';
          }
        }
        data = redacted;
      } else if (partial.type === 'done') {
        // Terminal marker — `data.result` IS the workflow return value.
        data = { result: '[redacted]' };
      } else if (partial.type === 'error') {
        // Terminal error marker — `data.message` can echo user / LLM
        // content. `name` / `code` are structural and pass through.
        const d = data as Record<string, unknown>;
        data = {
          ...d,
          ...(d.message !== undefined ? { message: '[redacted]' } : {}),
        };
      } else if (partial.type === 'log') {
        // `log` events can carry arbitrary user-emitted data (ctx.log) or
        // system events like await_human that include user-supplied prompts.
        // Conservative redaction: scrub string fields, preserve structural
        // ones (event name, channel, step counts, numeric observability
        // data). For nested objects, walk ONE level deep and apply the
        // same rules — this preserves `usage.tokens` / `usage.cost` on
        // memory events (numeric, non-PII, load-bearing for the Cost
        // Dashboard's byEmbedder bucket) while still scrubbing string
        // fields like `usage.model` that could carry tenant info.
        //
        // We deliberately don't recurse beyond one level. `ctx.log({ foo:
        // { bar: { baz: 'secret' } } })` will have `foo.bar` replaced
        // with an opaque sentinel — if a caller needs deeper structure
        // preserved they should flatten before emitting. One level is
        // exactly enough for the `usage` namespace shape we control.
        const d = data as Record<string, unknown>;
        const redacted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(d)) {
          // Keep the `event` discriminator and purely-numeric/boolean
          // fields visible at the top level.
          if (k === 'event' || typeof v === 'number' || typeof v === 'boolean') {
            redacted[k] = v;
          } else if (typeof v === 'string') {
            redacted[k] = '[redacted]';
          } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            // One-level walk: preserve numeric/boolean fields, scrub strings.
            // Arrays skipped — they're more commonly user data than structured
            // numeric buckets, and deep-scrubbing them loses shape.
            const inner = v as Record<string, unknown>;
            const innerRedacted: Record<string, unknown> = {};
            for (const [ik, iv] of Object.entries(inner)) {
              if (typeof iv === 'number' || typeof iv === 'boolean') {
                innerRedacted[ik] = iv;
              } else if (typeof iv === 'string') {
                innerRedacted[ik] = '[redacted]';
              } else {
                innerRedacted[ik] = '[redacted]';
              }
            }
            redacted[k] = innerRedacted;
          } else {
            // Arrays, null, or deeper nesting — opaque sentinel.
            redacted[k] = '[redacted]';
          }
        }
        data = redacted;
      }
    }
    // `as unknown as AxlEvent`: the loose internal `partial` type can't be
    // narrowed to a single discriminated union member at compile time, but the
    // runtime invariant is maintained by the gate/emission call sites that
    // always pair `type` with matching `data`/`tool`/etc.
    //
    // NOTE on redaction: we deliberately do NOT scrub top-level `cost`,
    // `tokens`, or `duration` under `config.trace.redact`. They are numeric
    // observability metrics (non-PII) and are load-bearing — `trackExecution`'s
    // cost-aggregation listener and Studio's CostAggregator both read
    // `event.cost` / `event.tokens` directly, so zeroing them would silently
    // break cost totals when redaction is enabled. In strict compliance
    // environments where even aggregate spend is sensitive, callers should
    // filter these events out entirely via `onTrace` rather than mutate them.
    //
    // NOTE on `workflow`: every trace event gets stamped with the owning
    // workflow name automatically (if set on the context). Previously each
    // caller had to explicitly pass `workflow` in the partial, and only
    // `_emitWorkflowStart` / `_emitWorkflowEnd` did so — which meant
    // `event.workflow` was undefined on every other event type in production.
    // Studio's `CostData.byWorkflow.cost` was effectively always $0 as a
    // result (workflows appeared with execution counts but zero spend).
    // Auto-stamping here is the single-source-of-truth fix: callers can
    // still override via `partial.workflow` if needed (e.g. a child context
    // emitting on behalf of its parent), but the common case "just works".
    // Read the ALS frame for ask correlation. The step counter prefers the
    // ALS frame's `stepRef` (which is `this.stepRefRoot` for top-level
    // asks, or the parent's counter for nested asks). Out-of-ask events
    // (workflow_start, workflow_end, ad-hoc log) also use `stepRefRoot` so
    // every event from this WorkflowContext shares one monotonic counter.
    const frame = askStorage.getStore();
    const step = (frame?.stepRef ?? this.stepRefRoot).value++;
    // Per-frame ask cost rollup. Only count cost-bearing leaf events
    // (`agent_call_end` / `tool_call_end`) emitted directly within this
    // frame — nested asks have their own frame and their own counter, and
    // their own `ask_end` event will surface their rollup. This keeps
    // `ask_end.cost` honest per spec decision 10.
    const cost = (partial as { cost?: number }).cost;
    if (
      frame &&
      typeof cost === 'number' &&
      (partial.type === 'agent_call_end' || partial.type === 'tool_call_end')
    ) {
      frame.askCost.value += cost;
    }
    // Inherit `parentToolCallId` from the ALS frame if present; this lets
    // tool-execution contexts thread the outer tool callId through nested
    // asks even when the WorkflowContext instance itself wasn't constructed
    // with `parentToolCallId` set.
    const parentToolCallId = this.parentToolCallId ?? frame?.parentToolCallId;
    const event = {
      executionId: this.executionId,
      step,
      timestamp: Date.now(),
      ...(this.workflowName ? { workflow: this.workflowName } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
      // Stamp ask correlation from ALS. Variants like `workflow_start` /
      // `workflow_end` and out-of-ask `log` events may legitimately have
      // no frame — they get no askId/parentAskId/depth, matching the
      // `Partial<AskScoped>` shape on those union members.
      ...(frame
        ? {
            askId: frame.askId,
            ...(frame.parentAskId ? { parentAskId: frame.parentAskId } : {}),
            depth: frame.depth,
            ...(frame.agent ? { agent: frame.agent } : {}),
          }
        : {}),
      ...partial,
      data,
    } as unknown as AxlEvent;
    // Isolate consumer bugs: a buggy onTrace handler must not crash the
    // workflow. Swallow and forward to console.error so the caller sees
    // the failure in ops but the workflow keeps running.
    if (this.onTrace) {
      try {
        this.onTrace(event);
      } catch (err) {
        console.error(
          '[axl] onTrace handler threw; trace event dropped:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}
