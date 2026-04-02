import { AsyncLocalStorage } from 'node:async_hooks';
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
  TraceEvent,
  ChatMessage,
  ToolCallMessage,
  ProviderResponse,
  AgentCallInfo,
  ValidateResult,
  VerifyRetry,
} from './types.js';
import {
  AxlError,
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
  onTrace?: (event: TraceEvent) => void;
  onToken?: (token: string) => void;
  onToolCall?: (call: { name: string; args: unknown; callId?: string }) => void;
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
  onAgentStart?: (info: { agent: string; model: string }) => void;
  /** Callback fired after each ctx.ask() completes (once per ask invocation). */
  onAgentCallComplete?: (call: AgentCallInfo) => void;
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
  private onTrace?: (event: TraceEvent) => void;
  private onToken?: (token: string) => void;
  private onToolCall?: (call: { name: string; args: unknown; callId?: string }) => void;
  private pendingDecisions?: Map<string, (d: HumanDecision) => void>;
  private budgetContext?: {
    totalCost: number;
    limit: number;
    exceeded: boolean;
    policy: string;
    abortController?: AbortController;
  };
  private stateStore?: StateStore;
  private stepCounter = 0;
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
  private onAgentStart?: (info: { agent: string; model: string }) => void;
  private onAgentCallComplete?: (call: AgentCallInfo) => void;
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
    // Restore cached summary from session metadata (survives across requests)
    if (init.metadata?.summaryCache) {
      this.summaryCache = init.metadata.summaryCache as string;
    }
  }

  /**
   * Create a child context for nested agent invocations (e.g., agent-as-tool).
   * Shares: budget tracking, abort signals, trace emission, provider registry,
   *         state store, span manager, memory manager, MCP manager, config,
   *         awaitHuman handler, pending decisions, tool overrides.
   * Isolates: session history, step counter, streaming callbacks (onToken, onAgentStart, onToolCall).
   */
  createChildContext(): WorkflowContext {
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
      onAgentCallComplete: this.onAgentCallComplete,
      awaitHumanHandler: this.awaitHumanHandler,
      pendingDecisions: this.pendingDecisions,
      toolOverrides: this.toolOverrides,
      signal: this.signal,
      workflowName: this.workflowName,
      // Isolated: sessionHistory (empty), stepCounter (0),
      // onToken (null), onAgentStart (null), onToolCall (null)
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

  // ── ctx.ask() ─────────────────────────────────────────────────────────

  async ask<T = string>(agent: Agent, prompt: string, options?: AskOptions<T>): Promise<T> {
    return this._checkpoint(async () => {
      const costBefore = this.budgetContext?.totalCost ?? 0;
      const startTime = Date.now();
      const resolveCtx = options?.metadata
        ? { metadata: { ...this.metadata, ...options.metadata } }
        : { metadata: this.metadata };

      // Use a mutable container to capture usage from executeAgentCall without
      // relying on an instance property (which is racy under concurrent calls).
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

      const result = this.spanManager
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
              span.setAttribute('axl.agent.duration', Date.now() - startTime);
              if (usageCapture.value) {
                span.setAttribute('axl.agent.prompt_tokens', usageCapture.value.prompt_tokens);
                span.setAttribute(
                  'axl.agent.completion_tokens',
                  usageCapture.value.completion_tokens,
                );
                if (usageCapture.value.cached_tokens)
                  span.setAttribute('axl.agent.cached_tokens', usageCapture.value.cached_tokens);
              }
              return r;
            },
          )
        : await doCall();

      const costAfter = this.budgetContext?.totalCost ?? 0;
      this.onAgentCallComplete?.({
        agent: agent._name,
        prompt,
        response: typeof result === 'string' ? result : JSON.stringify(result),
        model: agent.resolveModel(resolveCtx),
        cost: costAfter - costBefore,
        duration: Date.now() - startTime,
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
      return result;
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
        this.emitTrace({
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
      this.emitTrace({
        type: 'guardrail',
        agent: agent._name,
        data: { guardrailType: 'input', blocked: inputResult.block, reason: inputResult.reason },
      });
      this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': inputResult.block,
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

    // Streaming + validate is not supported: validate requires schema (JSON output),
    // and on retry the token stream would contain tokens from multiple attempts
    // concatenated together with no separator, producing garbled output.
    if (this.onToken && options?.validate) {
      throw new AxlError(
        'INVALID_CONFIG',
        'Cannot use validate with streaming. Validate requires schema (JSON output) which does not benefit from token streaming. Use a non-streaming call instead.',
      );
    }

    const currentMessages = [...messages];
    let turns = 0;
    let guardrailOutputRetries = 0;
    let schemaRetries = 0;
    let validateRetries = 0;

    while (turns < maxTurns) {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        throw new TimeoutError('ctx.ask()', timeoutMs);
      }

      turns++;

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

      this.onAgentStart?.({ agent: agent._name, model: modelUri });

      let response: ProviderResponse;

      if (this.onToken) {
        // Use streaming to emit tokens in real-time
        let content = '';
        const toolCalls: ToolCallMessage[] = [];
        const toolCallBuffers = new Map<string, { id: string; name: string; arguments: string }>();
        let streamProviderMetadata: Record<string, unknown> | undefined;

        let thinkingContent = '';

        for await (const chunk of provider.stream(currentMessages, chatOptions)) {
          if (chunk.type === 'text_delta') {
            content += chunk.content;
            this.onToken(chunk.content);
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
        if (this.budgetContext) {
          this.budgetContext.totalCost += response.cost;
          if (this.budgetContext.totalCost >= this.budgetContext.limit) {
            this.budgetContext.exceeded = true;
            // hard_stop: abort current in-flight operations immediately
            if (this.budgetContext.policy === 'hard_stop' && this.budgetContext.abortController) {
              this.budgetContext.abortController.abort();
            }
          }
        }
      }

      this.emitTrace({
        type: 'agent_call',
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
        duration: Date.now() - startTime,
        data: { prompt, response: response.content },
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
                      this.emitTrace({
                        type: 'handoff',
                        agent: agent._name,
                        data: { target: targetName, mode, duration },
                      });
                      return result;
                    },
                  );
                } else {
                  await executeRoundtrip();
                  this.emitTrace({
                    type: 'handoff',
                    agent: agent._name,
                    data: { target: targetName, mode, duration: Date.now() - handoffStart },
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
                    this.emitTrace({
                      type: 'handoff',
                      agent: agent._name,
                      data: { target: targetName, mode, duration },
                    });
                    return result;
                  },
                );
              }
              const onewayResult = await handoffFn();
              this.emitTrace({
                type: 'handoff',
                agent: agent._name,
                data: { target: targetName, mode, duration: Date.now() - handoffStart },
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
            this.onToolCall?.({ name: toolName, args: toolArgs, callId: toolCall.id });
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
            this.emitTrace({
              type: 'tool_call',
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
            this.emitTrace({ type: 'tool_denied', agent: agent._name, tool: toolName });
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

          this.onToolCall?.({ name: toolName, args: toolArgs, callId: toolCall.id });

          const toolStart = Date.now();

          // Approval gate: if tool requires approval, ask the human first.
          // Note: MCP tools have no `tool` object here (isMcpTool is true instead),
          // so they bypass the approval gate entirely. This is intentional — MCP tools
          // are externally managed and don't carry requireApproval config.
          if (tool && tool.requireApproval) {
            const approvalFn = async (): Promise<boolean> => {
              const decision = await this.awaitHuman({
                channel: 'tool_approval',
                prompt: `Tool "${toolName}" wants to execute with args: ${JSON.stringify(toolArgs)}`,
                metadata: { toolName, args: toolArgs, agent: agent._name },
              });
              if (!decision.approved) {
                const reason = decision.reason ?? 'Denied by human';
                this.emitTrace({
                  type: 'tool_denied',
                  agent: agent._name,
                  tool: toolName,
                  data: { denied: true, reason, args: toolArgs },
                });
                currentMessages.push({
                  role: 'tool',
                  content: JSON.stringify({ error: `Tool denied by human: ${reason}` }),
                  tool_call_id: toolCall.id,
                });
                return false;
              }
              return true;
            };

            let approved: boolean;
            if (this.spanManager) {
              approved = await this.spanManager.withSpanAsync(
                'axl.tool.approval',
                {
                  'axl.tool.name': toolName,
                  'axl.agent.name': agent._name,
                },
                async (span) => {
                  const result = await approvalFn();
                  span.setAttribute('axl.tool.approval.approved', result);
                  return result;
                },
              );
            } else {
              approved = await approvalFn();
            }

            if (!approved) continue;

            // Emit approval-succeeded trace so the stream handler can emit a tool_approval event
            this.emitTrace({
              type: 'tool_denied',
              agent: agent._name,
              tool: toolName,
              data: { denied: false, args: toolArgs },
            });
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
              // Execute local tool with a child context for nested agent invocations
              const childCtx = this.createChildContext();
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

          this.emitTrace({
            type: 'tool_call',
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
        this.emitTrace({
          type: 'guardrail',
          agent: agent._name,
          data: {
            guardrailType: 'output',
            blocked: outputResult.block,
            reason: outputResult.reason,
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
          'axl.guardrail.type': 'output',
          'axl.guardrail.blocked': outputResult.block,
          ...(outputResult.reason ? { 'axl.guardrail.reason': outputResult.reason } : {}),
        });
        if (outputResult.block) {
          const onBlock = guardrails.onBlock ?? 'throw';
          if (onBlock === 'retry') {
            const maxGuardrailRetries = guardrails.maxRetries ?? 2;
            if (guardrailOutputRetries < maxGuardrailRetries) {
              guardrailOutputRetries++;
              currentMessages.push({
                role: 'assistant',
                content,
                ...(response.providerMetadata
                  ? { providerMetadata: response.providerMetadata }
                  : {}),
              });
              currentMessages.push({
                role: 'system',
                content: `Your previous response was blocked by a safety guardrail: ${outputResult.reason ?? 'Output blocked'}. Please provide a different response that complies with the guidelines.`,
              });
              continue; // Re-enter the while loop for another LLM turn
            }
            // Max retries exhausted — fall through to throw
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
        try {
          const parsed = JSON.parse(extractJson(content));
          validated = (options.schema as z.ZodType).parse(parsed);
        } catch (err) {
          const maxSchemaRetries = options.retries ?? 3;
          if (schemaRetries < maxSchemaRetries) {
            schemaRetries++;
            const errorMsg = err instanceof Error ? err.message : String(err);
            currentMessages.push({
              role: 'assistant',
              content,
              ...(response.providerMetadata ? { providerMetadata: response.providerMetadata } : {}),
            });
            currentMessages.push({
              role: 'system',
              content: `Your response was not valid JSON or did not match the required schema: ${errorMsg}. Please fix and try again.`,
            });
            continue; // Re-enter the while loop for another LLM turn
          }
          const zodErr =
            err instanceof ZodError
              ? err
              : new ZodError([
                  {
                    code: 'custom',
                    path: [],
                    message: err instanceof Error ? err.message : String(err),
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

        this.emitTrace({
          type: 'validate',
          agent: agent._name,
          data: {
            valid: validateResult.valid,
            ...(validateResult.reason ? { reason: validateResult.reason } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.validate.check', {
          'axl.validate.valid': validateResult.valid,
          ...(validateResult.reason ? { 'axl.validate.reason': validateResult.reason } : {}),
        });

        if (!validateResult.valid) {
          const maxValidateRetries = options.validateRetries ?? 2;
          if (validateRetries < maxValidateRetries) {
            validateRetries++;
            currentMessages.push({
              role: 'assistant',
              content,
              ...(response.providerMetadata ? { providerMetadata: response.providerMetadata } : {}),
            });
            currentMessages.push({
              role: 'system',
              content: `Your response parsed correctly but failed validation: ${validateResult.reason ?? 'Validation failed'}. Previous attempts are visible above. Please fix and try again.`,
            });
            continue; // Re-enter the while loop — goes through all gates again
          }
          throw new ValidationError(
            validated,
            validateResult.reason ?? 'Validation failed',
            maxValidateRetries,
          );
        }
      }

      // All gates passed — push to session history and return
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
      this.emitTrace({
        type: 'log',
        data: { event: 'checkpoint_replay', step },
      });
      this.spanManager?.addEventToActiveSpan('axl.checkpoint.hit', { 'axl.checkpoint.step': step });
      return saved as T;
    }

    // Execute and save the result
    const result = await fn();

    await this.stateStore.saveCheckpoint(this.executionId, step, result);

    this.emitTrace({
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
              if (options?.fallback !== undefined) return options.fallback;
              throw new ValidationError(parsed, errorMsg, maxRetries);
            }
            continue;
          }
        }

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
            if (options?.fallback !== undefined) return options.fallback;
            throw err;
          }
          continue;
        }

        const errorMsg =
          err instanceof ZodError ? err.message : err instanceof Error ? err.message : String(err);
        lastRetry = { error: errorMsg, output: rawOutput };

        if (attempt === maxRetries) {
          if (options?.fallback !== undefined) return options.fallback;
          const zodErr =
            err instanceof ZodError
              ? err
              : new ZodError([{ code: 'custom', path: [], message: errorMsg }]);
          throw new VerifyError(rawOutput, zodErr, maxRetries);
        }
      }
    }

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
      this.emitTrace({
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
        step: this.stepCounter,
        status: 'waiting',
        metadata: {
          ...this.metadata,
          awaitHumanChannel: options.channel,
          awaitHumanPrompt: options.prompt,
        },
      });
    }

    this.emitTrace({
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
        step: this.stepCounter,
        status: 'running',
      });
    }

    return decision;
  }

  // ── ctx.log() ─────────────────────────────────────────────────────────

  log(event: string, data?: unknown): void {
    this.emitTrace({
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
    const sessionId = this.metadata?.sessionId as string | undefined;
    await this.memoryManager.remember(key, value, this.stateStore, sessionId, options);
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
    const sessionId = this.metadata?.sessionId as string | undefined;
    return this.memoryManager.recall(key, this.stateStore, sessionId, options);
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
    await this.memoryManager.forget(key, this.stateStore, sessionId, options);
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

    this.emitTrace({
      type: 'delegate',
      agent: '_delegate_router',
      data: {
        candidates: agents.map((a) => a._name),
        routerModel: routerModelUri,
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

  private emitTrace(partial: Omit<TraceEvent, 'executionId' | 'step' | 'timestamp'>): void {
    let data = partial.data;
    if (this.config.trace?.redact && partial.type === 'agent_call' && data) {
      data = { ...(data as Record<string, unknown>), prompt: '[redacted]', response: '[redacted]' };
    }
    const event: TraceEvent = {
      executionId: this.executionId,
      step: this.stepCounter++,
      timestamp: Date.now(),
      ...partial,
      data,
    };
    this.onTrace?.(event);
  }
}
