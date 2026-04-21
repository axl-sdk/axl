import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AxlConfig } from './config.js';
import { parseCost, resolveConfig } from './config.js';
import type { Workflow } from './workflow.js';
import type { Tool } from './tool.js';
import type { Agent } from './agent.js';
import type { Provider } from './providers/types.js';
import { ProviderRegistry } from './providers/registry.js';
import type { StateStore, PendingDecision, EvalHistoryEntry } from './state/types.js';
import { MemoryStore } from './state/memory.js';
import { SQLiteStore } from './state/sqlite.js';
import { WorkflowContext } from './context.js';
import { Session, type SessionOptions } from './session.js';
import { AxlStream } from './stream.js';
import { McpManager } from './mcp/manager.js';
import { MemoryManager } from './memory/manager.js';
import type {
  AxlEvent,
  ExecutionInfo,
  HumanDecision,
  AwaitHumanOptions,
  ChatMessage,
  HandoffRecord,
} from './types.js';
import { NoopSpanManager } from './telemetry/noop.js';
import { createSpanManager } from './telemetry/index.js';
import type { SpanManager } from './telemetry/types.js';

/** Simple DJB2 hash of input for span correlation. */
function hashInput(input: unknown): string {
  const str = JSON.stringify(input) ?? '';
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export type ExecuteOptions = {
  metadata?: Record<string, unknown>;
  /** Handler for tool approval requests. When provided, tools with `requireApproval` resolve
   *  via this handler instead of suspending the execution and registering a pending decision.
   *  Useful for in-process testing and ad-hoc invocations where you don't want to poll
   *  `runtime.getPendingDecisions()` and call `runtime.resolveDecision()`. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => Promise<HumanDecision>;
};

/**
 * Shape of events forwarded to an eval `onProgress` callback. Mirrors
 * `@axlsdk/eval`'s `EvalProgressEvent` so runtime consumers can type their
 * callbacks without importing the optional peer dep.
 */
export type EvalProgressEventShape =
  | { type: 'item_done'; itemIndex: number; totalItems: number }
  | { type: 'run_done'; totalItems: number; failures: number };

export type CreateContextOptions = {
  metadata?: Record<string, unknown>;
  /** Cost budget for the context (e.g., '$0.50'). Enforced via finish_and_stop policy. */
  budget?: string;
  /** Abort signal for cancellation/timeouts. */
  signal?: AbortSignal;
  /** Prior conversation history for multi-turn eval testing. */
  sessionHistory?: ChatMessage[];
  /** Token streaming callback. */
  onToken?: (token: string) => void;
  /** Handler for tool approval requests. Called when an agent invokes a tool with requireApproval. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => Promise<HumanDecision>;
};

/** Cost scope for tracking cost across async boundaries via AsyncLocalStorage. */
type CostScope = {
  totalCost: number;
  trackedIds: Set<string>;
  parent?: CostScope;
};

const costScopeStorage = new AsyncLocalStorage<CostScope>();

/**
 * The main entry point for executing Axl workflows.
 * Manages workflow registration, provider resolution, state storage, tracing, MCP servers,
 * and human-in-the-loop decision handling. Supports both synchronous (`execute`) and
 * streaming (`stream`) execution modes, as well as multi-turn sessions.
 */
export class AxlRuntime extends EventEmitter {
  private config: AxlConfig;
  private workflows = new Map<string, Workflow>();
  private tools = new Map<string, Tool>();
  private agents = new Map<string, Agent>();
  private providerRegistry: ProviderRegistry;
  private stateStore: StateStore;
  private executions = new Map<string, ExecutionInfo>();
  private pendingDecisionResolvers = new Map<string, (d: HumanDecision) => void>();
  private abortControllers = new Map<string, AbortController>();
  private registeredEvals = new Map<
    string,
    {
      config: unknown;
      executeWorkflow?: (
        input: unknown,
        runtime?: AxlRuntime,
      ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>;
    }
  >();
  private mcpManager?: McpManager;
  private memoryManager?: MemoryManager;
  private spanManager: SpanManager = new NoopSpanManager();
  private historicalExecutions = new Map<string, ExecutionInfo>();
  private historicalExecutionsLoadPromise: Promise<void> | null = null;
  private evalHistory: EvalHistoryEntry[] = [];
  private evalHistoryLoadPromise: Promise<void> | null = null;

  constructor(config?: AxlConfig) {
    super();
    this.config = resolveConfig(config ?? {});
    this.providerRegistry = new ProviderRegistry();
    this.stateStore = this.createStateStore();
    if (this.config.memory) {
      this.memoryManager = new MemoryManager({
        vectorStore: this.config.memory.vectorStore,
        embedder: this.config.memory.embedder,
      });
    }
  }

  /**
   * Whether `config.trace.redact` is enabled on this runtime. A narrow
   * boolean getter is preferred over exposing the full config because:
   * (a) `Readonly<AxlConfig>` is shallow so the config would be mutable
   * at runtime through sub-objects, subverting any compliance guarantee;
   * (b) observability consumers like Studio only need the boolean, not
   * the whole config tree; (c) if future observability config needs to
   * expand, each new flag gets its own narrow getter.
   *
   * Studio's server-side redaction helpers (executions, memory, sessions,
   * evals, decisions, tools, playground, workflows) all route through
   * this accessor to decide whether to scrub response payloads.
   */
  isRedactEnabled(): boolean {
    return this.config.trace?.redact === true;
  }

  /**
   * Initialize MCP servers configured in the config.
   * Call this before executing workflows that use MCP tools.
   */
  async initializeMcp(): Promise<void> {
    if (this.config.mcp?.servers && this.config.mcp.servers.length > 0) {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize(this.config.mcp.servers);
    }
  }

  /**
   * Initialize OpenTelemetry telemetry based on config.
   * Call this before executing workflows to enable span creation.
   */
  async initializeTelemetry(): Promise<void> {
    this.spanManager = await createSpanManager(this.config.telemetry);
  }

  /** Get the MCP manager (if initialized). */
  getMcpManager(): McpManager | undefined {
    return this.mcpManager;
  }

  private createStateStore(): StateStore {
    const storeOption = this.config.state?.store ?? 'memory';
    if (typeof storeOption !== 'string') return storeOption;
    switch (storeOption) {
      case 'sqlite':
        return new SQLiteStore(this.config.state?.sqlite?.path ?? './data/axl.db');
      case 'memory':
      default:
        return new MemoryStore();
    }
  }

  /**
   * Persist a completed/failed execution to the state store (fire-and-forget)
   * and move it from the active executions map to the historical cache.
   */
  private persistExecution(execInfo: ExecutionInfo): void {
    const snapshot = structuredClone(execInfo);

    if (this.stateStore.saveExecution) {
      this.stateStore.saveExecution(snapshot).catch(() => {
        // Best-effort persistence — execution still succeeded/failed normally
      });
    }

    // Move from active to historical cache to bound active map growth.
    // Use the snapshot so the cached entry is not mutated by lingering closures.
    const id = execInfo.executionId;
    this.historicalExecutions.set(id, snapshot);
    this.executions.delete(id);
  }

  /** Register a workflow with the runtime. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(workflow: Workflow<any, any>): void {
    this.workflows.set(workflow.name, workflow);
  }

  /** Register standalone tools for Studio introspection and direct testing. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(...tools: Tool<any, any>[]): void {
    for (const t of tools) {
      this.tools.set(t.name, t);
    }
  }

  /** Register standalone agents for Studio playground and introspection. */
  registerAgent(...agents: Agent[]): void {
    for (const a of agents) {
      this.agents.set(a._name, a);
    }
  }

  // ── Introspection (used by Studio) ────────────────────────────────

  /** Get all registered workflow names. */
  getWorkflowNames(): string[] {
    return [...this.workflows.keys()];
  }

  /** Get a registered workflow by name. */
  getWorkflow(name: string): Workflow | undefined {
    return this.workflows.get(name);
  }

  /** Get all registered workflows. */
  getWorkflows(): Workflow[] {
    return [...this.workflows.values()];
  }

  /** Get all registered standalone tools. */
  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  /** Get a registered standalone tool by name. */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered standalone agents. */
  getAgents(): Agent[] {
    return [...this.agents.values()];
  }

  /** Get a registered standalone agent by name. */
  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /**
   * Register an eval config for Studio introspection and execution.
   * The config should be the result of `defineEval()` from `@axlsdk/eval`.
   * An optional `executeWorkflow` function can override the default behavior
   * of calling `runtime.execute()`.
   */
  registerEval(
    name: string,
    config: unknown,
    executeWorkflow?: (
      input: unknown,
      runtime?: AxlRuntime,
    ) => Promise<{ output: unknown; cost?: number }>,
  ): void {
    this.registeredEvals.set(name, { config, executeWorkflow });
  }

  /** Get metadata about all registered evals. */
  getRegisteredEvals(): Array<{
    name: string;
    workflow: string;
    dataset: string;
    scorers: string[];
  }> {
    const result: Array<{ name: string; workflow: string; dataset: string; scorers: string[] }> =
      [];
    for (const [name, { config }] of this.registeredEvals) {
      const cfg = config as {
        workflow?: string;
        dataset?: { name?: string };
        scorers?: Array<{ name?: string }>;
      };
      result.push({
        name,
        workflow: cfg.workflow ?? 'unknown',
        dataset: cfg.dataset?.name ?? 'unknown',
        scorers: (cfg.scorers ?? []).map((s) => s.name ?? 'unknown'),
      });
    }
    return result;
  }

  /** Get a registered eval config by name. */
  getRegisteredEval(name: string):
    | {
        config: unknown;
        executeWorkflow?: (
          input: unknown,
          runtime?: AxlRuntime,
        ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>;
      }
    | undefined {
    return this.registeredEvals.get(name);
  }

  /** Run a registered eval by name. */
  async runRegisteredEval(
    name: string,
    options?: {
      metadata?: Record<string, unknown>;
      /** Called after each dataset item completes (execution + scoring). */
      onProgress?: (event: EvalProgressEventShape) => void;
      /** Abort signal — checked before starting each item. */
      signal?: AbortSignal;
      /**
       * When `true`, populate `EvalItem.traces` on every item (success + failure
       * paths). Forwards to `runEval({ captureTraces: true })`, which wraps each
       * item's execution in `runtime.trackExecution({ captureTraces: true })`.
       * Verbose-mode `agent_call.data.messages` snapshots are stripped from
       * captured traces to keep memory bounded.
       */
      captureTraces?: boolean;
    },
  ): Promise<unknown> {
    const entry = this.registeredEvals.get(name);
    if (!entry) throw new Error(`Eval "${name}" is not registered`);

    let result: unknown;

    if (entry.executeWorkflow) {
      // Use custom executeWorkflow if provided, injecting this runtime as second arg
      let runEvalFn: (
        config: unknown,
        executeFn: (
          input: unknown,
          runtime: unknown,
        ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
        runtime: unknown,
        evalOptions?: {
          onProgress?: (event: EvalProgressEventShape) => void;
          signal?: AbortSignal;
          captureTraces?: boolean;
        },
      ) => Promise<unknown>;
      try {
        // @ts-expect-error — @axlsdk/eval is an optional peer dependency
        ({ runEval: runEvalFn } = await import('@axlsdk/eval'));
      } catch {
        throw new Error(
          'axl-eval is required for AxlRuntime.runRegisteredEval(). Install it with: npm install @axlsdk/eval',
        );
      }
      const originalExecuteFn = entry.executeWorkflow!;

      // Wrap with trackExecution for transparent cost + metadata capture.
      // When captureTraces is on, runEval wraps this again in a second
      // trackExecution({ captureTraces: true }) — nested trackExecution walks
      // the AsyncLocalStorage parent chain so both scopes observe events.
      const wrappedExecuteFn = async (
        input: unknown,
        runtime: unknown,
      ): Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }> => {
        const {
          result,
          cost: trackedCost,
          metadata,
        } = await this.trackExecution(async () => {
          return originalExecuteFn(input, runtime as AxlRuntime);
        });
        // Prefer user-supplied cost if present, fall back to tracked cost
        return {
          output: result.output,
          cost: result.cost ?? trackedCost,
          metadata: result.metadata ?? metadata,
        };
      };

      result = await runEvalFn(entry.config, wrappedExecuteFn, this, {
        onProgress: options?.onProgress,
        signal: options?.signal,
        captureTraces: options?.captureTraces,
      });
    } else {
      // Default: use runtime.eval() which creates its own executeWorkflow
      result = await this.eval(
        entry.config as {
          workflow: string;
          dataset: unknown;
          scorers: unknown[];
          concurrency?: number;
          budget?: string;
          metadata?: Record<string, unknown>;
        },
        {
          onProgress: options?.onProgress,
          signal: options?.signal,
          captureTraces: options?.captureTraces,
        },
      );
    }

    // Merge extra metadata if provided (e.g., runGroupId for multi-run)
    const resultObj = result as Record<string, unknown>;
    if (options?.metadata) {
      resultObj.metadata = {
        ...(resultObj.metadata as Record<string, unknown>),
        ...options.metadata,
      };
    }

    // Persist eval result to history (best-effort — don't lose the result on store errors)
    try {
      await this.saveEvalResult({
        id: (resultObj.id as string) ?? randomUUID(),
        eval: name,
        timestamp: Date.now(),
        data: structuredClone(result),
      });
    } catch {
      // Best-effort persistence — eval still succeeded
    }

    return result;
  }

  /** Get all execution info (running + completed + historical). */
  async getExecutions(): Promise<ExecutionInfo[]> {
    // Lazy-load historical executions from store on first access (once-guard)
    if (!this.historicalExecutionsLoadPromise && this.stateStore.listExecutions) {
      this.historicalExecutionsLoadPromise = this.stateStore
        .listExecutions()
        .then((stored) => {
          for (const exec of stored) {
            if (
              !this.executions.has(exec.executionId) &&
              !this.historicalExecutions.has(exec.executionId)
            ) {
              this.historicalExecutions.set(exec.executionId, exec);
            }
          }
        })
        .catch(() => {
          // Failed to load — reset so next call retries
          this.historicalExecutionsLoadPromise = null;
        });
    }
    if (this.historicalExecutionsLoadPromise) {
      await this.historicalExecutionsLoadPromise;
    }

    // Merge: in-memory takes precedence (has live data)
    const merged = new Map(this.historicalExecutions);
    for (const [id, exec] of this.executions) {
      merged.set(id, exec);
    }
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Create a WorkflowContext for ad-hoc use (evals, tool testing, prototyping).
   * The context has access to the runtime's providers, state store, MCP manager,
   * and automatically emits trace events and tracks cost.
   */
  createContext(options?: CreateContextOptions): WorkflowContext {
    const executionId = randomUUID();
    const budgetLimit = options?.budget ? parseCost(options.budget) : Infinity;

    // Register with active cost scope for trackCost() attribution
    this.registerWithCostScope(executionId);

    return new WorkflowContext({
      input: undefined,
      executionId,
      metadata: options?.metadata,
      config: this.config,
      providerRegistry: this.providerRegistry,
      stateStore: this.stateStore,
      mcpManager: this.mcpManager,
      spanManager: this.spanManager,
      memoryManager: this.memoryManager,
      sessionHistory: options?.sessionHistory,
      signal: options?.signal,
      onToken: options?.onToken,
      awaitHumanHandler: options?.awaitHumanHandler,
      onTrace: (event: AxlEvent) => {
        this.emit('trace', event);
        this.outputAxlEvent(event);
      },
      budgetContext: {
        totalCost: 0,
        limit: budgetLimit,
        exceeded: false,
        policy: 'finish_and_stop',
      },
    });
  }

  /** Register a custom provider instance. */
  registerProvider(name: string, provider: Provider): void {
    this.providerRegistry.registerInstance(name, provider);
  }

  /** Resolve a provider:model URI to a Provider instance and model name. */
  resolveProvider(uri: string): { provider: Provider; model: string } {
    return this.providerRegistry.resolve(uri, this.config);
  }

  /** Execute a workflow and return the result. */
  async execute(name: string, input: unknown, options?: ExecuteOptions): Promise<unknown> {
    const workflow = this.workflows.get(name);
    if (!workflow) {
      throw new Error(
        `Workflow "${name}" not registered. Available: ${[...this.workflows.keys()].join(', ')}`,
      );
    }

    // Validate input
    const validated = workflow.inputSchema.parse(input);
    const executionId = randomUUID();
    const controller = new AbortController();
    this.abortControllers.set(executionId, controller);

    // Register with active cost scope for trackCost() attribution
    this.registerWithCostScope(executionId);

    // Create execution info
    const execInfo: ExecutionInfo = {
      executionId,
      workflow: name,
      status: 'running',
      events: [],
      totalCost: 0,
      startedAt: Date.now(),
      duration: 0,
    };
    this.executions.set(executionId, execInfo);

    // Resolve session history from metadata if present
    const sessionHistory = (options?.metadata?.sessionHistory as ChatMessage[]) ?? undefined;

    // Create workflow context
    const ctx = new WorkflowContext({
      input: validated,
      executionId,
      metadata: options?.metadata,
      config: this.config,
      providerRegistry: this.providerRegistry,
      sessionHistory,
      signal: controller.signal,
      onTrace: (event: AxlEvent) => {
        execInfo.events.push(event);
        if (event.cost) execInfo.totalCost += event.cost;
        this.emit('trace', event);
        this.outputAxlEvent(event);
        // Persist handoff records to session metadata
        if (event.type === 'handoff') {
          const sessionId = options?.metadata?.sessionId as string | undefined;
          if (sessionId) {
            const data = event.data as Record<string, unknown> | undefined;
            this.appendHandoffRecord(sessionId, {
              source: event.agent ?? '',
              target: (data?.target as string) ?? '',
              mode: (data?.mode as 'oneway' | 'roundtrip') ?? 'oneway',
              timestamp: event.timestamp,
              duration: (data?.duration as number) ?? undefined,
            });
          }
        }
      },
      pendingDecisions: this.pendingDecisionResolvers,
      awaitHumanHandler: options?.awaitHumanHandler,
      stateStore: this.stateStore,
      workflowName: name,
      mcpManager: this.mcpManager,
      memoryManager: this.memoryManager,
      resumeMode: !!options?.metadata?.resumeMode,
      spanManager: this.spanManager,
      budgetContext: {
        totalCost: 0,
        limit: Infinity,
        exceeded: false,
        policy: 'finish_and_stop',
      },
    });

    return this.spanManager.withSpanAsync(
      'axl.workflow.execute',
      {
        'axl.workflow.name': name,
        'axl.execution.id': executionId,
        'axl.workflow.input_hash': hashInput(validated),
      },
      async (span) => {
        try {
          // Emit workflow_start inside the span context so OTel exporters
          // that correlate trace events to spans via active-context see it.
          // BREAKING CHANGE from v0.14.x — previously emitted as
          // `type: 'log'` with `data.event: 'workflow_start'`.
          ctx._emitWorkflowStart(validated);
          const result = await workflow.handler(ctx);

          // Validate (and coerce) output if schema exists
          const output = workflow.outputSchema ? workflow.outputSchema.parse(result) : result;

          execInfo.status = 'completed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.result = output;
          ctx._emitWorkflowEnd({
            status: 'completed',
            duration: execInfo.duration,
            result: output,
          });

          // Clean up checkpoints for completed execution
          if (this.stateStore.deleteCheckpoints) {
            await this.stateStore.deleteCheckpoints(executionId);
          }

          span.setAttribute('axl.workflow.cost', execInfo.totalCost);
          span.setAttribute('axl.workflow.duration', execInfo.duration);

          this.persistExecution(execInfo);
          return output;
        } catch (err) {
          // Detect AbortError from both `DOMException` (browser / Node fetch path)
          // and a plain `Error` with `name === 'AbortError'` (signal.throwIfAborted,
          // user-thrown abort). A strict instanceof check misses cancellations
          // thrown by other code paths.
          const aborted =
            typeof err === 'object' &&
            err !== null &&
            (err as { name?: unknown }).name === 'AbortError';
          execInfo.status = 'failed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.error = err instanceof Error ? err.message : String(err);
          ctx._emitWorkflowEnd({
            status: 'failed',
            duration: execInfo.duration,
            error: execInfo.error,
            ...(aborted ? { aborted: true } : {}),
          });
          this.persistExecution(execInfo);
          throw err;
        } finally {
          this.abortControllers.delete(executionId);
        }
      },
    );
  }

  /** Execute a workflow and return a stream. */
  stream(name: string, input: unknown, options?: ExecuteOptions): AxlStream {
    const axlStream = new AxlStream();
    const controller = new AbortController();

    // Cancel workflow when consumer disconnects (stops reading the stream)
    axlStream.on('close', () => controller.abort());

    // Execute asynchronously, piping events to the stream.
    // execInfo and ctx are captured by the closure so the catch handler can update them on error.
    let execInfo: ExecutionInfo | undefined;
    let ctx: WorkflowContext | undefined;

    const run = async () => {
      const workflow = this.workflows.get(name);
      if (!workflow) throw new Error(`Workflow "${name}" not registered`);

      const validated = workflow.inputSchema.parse(input);
      const executionId = randomUUID();
      this.abortControllers.set(executionId, controller);
      const sessionHistory = (options?.metadata?.sessionHistory as ChatMessage[]) ?? undefined;

      // Register with active cost scope for trackCost() attribution
      this.registerWithCostScope(executionId);

      // Create execution info for stream executions
      execInfo = {
        executionId,
        workflow: name,
        status: 'running',
        events: [],
        totalCost: 0,
        startedAt: Date.now(),
        duration: 0,
      };
      this.executions.set(executionId, execInfo);

      const wfCtx = new WorkflowContext({
        input: validated,
        executionId,
        metadata: options?.metadata,
        config: this.config,
        providerRegistry: this.providerRegistry,
        sessionHistory,
        signal: controller.signal,
        onTrace: (event: AxlEvent) => {
          execInfo!.events.push(event);
          if (event.cost) execInfo!.totalCost += event.cost;
          this.emit('trace', event);
          this.outputAxlEvent(event);
          // Emit typed stream events for specific trace types
          if (event.type === 'handoff') {
            const data = event.data as Record<string, unknown> | undefined;
            axlStream._push({
              type: 'handoff',
              source: event.agent ?? '',
              target: (data?.target as string) ?? '',
              mode: (data?.mode as 'oneway' | 'roundtrip') ?? undefined,
            });
            // Persist handoff records to session metadata
            const sessionId = options?.metadata?.sessionId as string | undefined;
            if (sessionId) {
              this.appendHandoffRecord(sessionId, {
                source: event.agent ?? '',
                target: (data?.target as string) ?? '',
                mode: (data?.mode as 'oneway' | 'roundtrip') ?? 'oneway',
                timestamp: event.timestamp,
                duration: (data?.duration as number) ?? undefined,
              });
            }
          } else if (event.type === 'tool_approval') {
            // Approval gate decision — emit a `tool_approval` stream event that
            // mirrors the trace event. Fires on both approve and deny so UI
            // consumers can show the decision inline with the tool call.
            const data = event.data as
              | { approved?: boolean; args?: unknown; reason?: string }
              | undefined;
            axlStream._push({
              type: 'tool_approval',
              name: event.tool ?? '',
              args: data?.args,
              approved: data?.approved === true,
              ...(data?.reason ? { reason: data.reason } : {}),
            });
          } else if (event.type === 'tool_denied') {
            // Agent tried to call a tool that doesn't exist (not an approval denial).
            // No equivalent stream event today — the step event below still fires
            // so consumers subscribing to all steps can react if needed.
          } else if (event.type === 'agent_call_end') {
            axlStream._push({
              type: 'agent_end',
              agent: event.agent ?? '',
              cost: event.cost,
              duration: event.duration,
            });
          } else if (event.type === 'tool_call_end') {
            axlStream._push({
              type: 'tool_result',
              name: event.tool ?? '',
              result: (event.data as Record<string, unknown>)?.result,
              callId: (event.data as Record<string, unknown>)?.callId as string | undefined,
            });
          }
          // Always emit raw step event for backwards compat
          axlStream._push({ type: 'step', step: event.step, data: event });
        },
        onToken: (token: string) => {
          axlStream._push({ type: 'token', data: token });
        },
        onToolCall: (call: { name: string; args: unknown; callId?: string }) => {
          axlStream._push({
            type: 'tool_call',
            name: call.name,
            args: call.args,
            callId: call.callId,
          });
        },
        onAgentStart: (info: { agent: string; model: string }) => {
          axlStream._push({ type: 'agent_start', agent: info.agent, model: info.model });
        },
        pendingDecisions: this.pendingDecisionResolvers,
        awaitHumanHandler: options?.awaitHumanHandler,
        stateStore: this.stateStore,
        workflowName: name,
        mcpManager: this.mcpManager,
        memoryManager: this.memoryManager,
        resumeMode: !!options?.metadata?.resumeMode,
        spanManager: this.spanManager,
        budgetContext: {
          totalCost: 0,
          limit: Infinity,
          exceeded: false,
          policy: 'finish_and_stop',
        },
      });
      ctx = wfCtx;

      return this.spanManager.withSpanAsync(
        'axl.workflow.execute',
        {
          'axl.workflow.name': name,
          'axl.execution.id': executionId,
          'axl.workflow.input_hash': hashInput(validated),
        },
        async (span) => {
          try {
            // Parity fix: stream() used to never emit workflow_start
            // (execute() did). Now both code paths emit it inside the span
            // context as a first-class trace event.
            wfCtx._emitWorkflowStart(validated);
            const rawResult = await workflow.handler(wfCtx);
            const result = workflow.outputSchema
              ? workflow.outputSchema.parse(rawResult)
              : rawResult;

            execInfo!.status = 'completed';
            execInfo!.completedAt = Date.now();
            execInfo!.duration = execInfo!.completedAt - execInfo!.startedAt;
            execInfo!.result = result;
            wfCtx._emitWorkflowEnd({
              status: 'completed',
              duration: execInfo!.duration,
              result,
            });

            // Clean up checkpoints for completed execution
            if (this.stateStore.deleteCheckpoints) {
              await this.stateStore.deleteCheckpoints(executionId);
            }

            span.setAttribute('axl.workflow.cost', execInfo!.totalCost);
            span.setAttribute('axl.workflow.duration', execInfo!.duration);

            this.persistExecution(execInfo!);
            return result;
          } finally {
            this.abortControllers.delete(executionId);
          }
        },
      );
    };

    run()
      .then((result) => axlStream._done(result))
      .catch((err) => {
        // Update execution status on error
        if (execInfo) {
          // Detect AbortError from both `DOMException` (browser / Node fetch path)
          // and a plain `Error` with `name === 'AbortError'` (signal.throwIfAborted,
          // user-thrown abort). A strict instanceof check misses cancellations
          // thrown by other code paths.
          const aborted =
            typeof err === 'object' &&
            err !== null &&
            (err as { name?: unknown }).name === 'AbortError';
          execInfo.status = 'failed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.error = err instanceof Error ? err.message : String(err);
          ctx?._emitWorkflowEnd({
            status: 'failed',
            duration: execInfo.duration,
            error: execInfo.error,
            ...(aborted ? { aborted: true } : {}),
          });
          this.persistExecution(execInfo);
        }
        axlStream._error(err instanceof Error ? err : new Error(String(err)));
      });

    return axlStream;
  }

  /** Create or resume a session. */
  session(id: string, options?: SessionOptions): Session {
    return new Session(id, this, this.stateStore, options);
  }

  /** Gracefully shut down the runtime, aborting in-flight executions and closing state stores and MCP servers. */
  async shutdown(): Promise<void> {
    // Abort all in-flight executions
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    const errors: Error[] = [];
    const safeClose = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`));
      }
    };

    if (this.mcpManager) await safeClose('mcpManager', () => this.mcpManager!.shutdown());
    if (this.memoryManager) await safeClose('memoryManager', () => this.memoryManager!.close());
    if (this.stateStore.close) await safeClose('stateStore', () => this.stateStore.close!());
    await safeClose('spanManager', () => this.spanManager.shutdown());

    if (errors.length > 0) {
      throw new Error(
        `shutdown encountered ${errors.length} error(s): ${errors.map((e) => e.message).join('; ')}`,
      );
    }
  }

  /** Abort a running execution by its ID. */
  abort(executionId: string): void {
    const controller = this.abortControllers.get(executionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(executionId);
    }
  }

  /** Get execution details by ID. */
  async getExecution(executionId: string): Promise<ExecutionInfo | undefined> {
    // Check active in-memory executions first
    const inMemory = this.executions.get(executionId);
    if (inMemory) return inMemory;

    // Check historical cache
    const cached = this.historicalExecutions.get(executionId);
    if (cached) return cached;

    // Fall through to store
    if (this.stateStore.getExecution) {
      const stored = await this.stateStore.getExecution(executionId);
      if (stored) {
        this.historicalExecutions.set(executionId, stored);
        return stored;
      }
    }

    return undefined;
  }

  /** Save an eval result to history. */
  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    // Add to in-memory cache (newest first)
    this.evalHistory.unshift(entry);

    // Persist to store
    if (this.stateStore.saveEvalResult) {
      await this.stateStore.saveEvalResult(entry);
    }

    // Emit for live aggregation (e.g., Studio eval trends)
    this.emit('eval_result', entry);
  }

  /**
   * Delete an eval history entry by id. Removes from in-memory cache and
   * the configured StateStore. Returns true if an entry was actually removed.
   *
   * Ensures lazy-loaded history is loaded first so the in-memory cache and
   * the store can't drift apart on the deletion path.
   */
  async deleteEvalResult(id: string): Promise<boolean> {
    // Force a lazy-load so the in-memory cache reflects everything in the
    // store before we mutate it.
    await this.getEvalHistory();

    const beforeLength = this.evalHistory.length;
    this.evalHistory = this.evalHistory.filter((e) => e.id !== id);
    const removedFromMemory = this.evalHistory.length < beforeLength;

    let removedFromStore = false;
    if (this.stateStore.deleteEvalResult) {
      removedFromStore = await this.stateStore.deleteEvalResult(id);
    }

    return removedFromMemory || removedFromStore;
  }

  /** Get eval result history (most recent first). */
  async getEvalHistory(): Promise<EvalHistoryEntry[]> {
    // Lazy-load from store on first access (once-guard)
    if (!this.evalHistoryLoadPromise && this.stateStore.listEvalResults) {
      this.evalHistoryLoadPromise = this.stateStore
        .listEvalResults()
        .then((stored) => {
          // Merge: stored entries not already in memory
          const ids = new Set(this.evalHistory.map((e) => e.id));
          for (const entry of stored) {
            if (!ids.has(entry.id)) {
              this.evalHistory.push(entry);
            }
          }
          // Re-sort by timestamp descending
          this.evalHistory.sort((a, b) => b.timestamp - a.timestamp);
        })
        .catch(() => {
          // Failed to load — reset so next call retries
          this.evalHistoryLoadPromise = null;
        });
    }
    if (this.evalHistoryLoadPromise) {
      await this.evalHistoryLoadPromise;
    }
    return [...this.evalHistory];
  }

  /** List pending human decisions. */
  async getPendingDecisions(): Promise<PendingDecision[]> {
    return this.stateStore.getPendingDecisions();
  }

  /** Resolve a pending human decision. */
  async resolveDecision(executionId: string, decision: HumanDecision): Promise<void> {
    const resolver = this.pendingDecisionResolvers.get(executionId);
    if (resolver) {
      // In-memory resolver exists — workflow is still running in this process
      resolver(decision);
      this.pendingDecisionResolvers.delete(executionId);
    }
    await this.stateStore.resolveDecision(executionId, decision);

    // Cross-restart: if no in-memory resolver, the workflow was lost on restart.
    // Trigger a re-execution that replays from checkpoints.
    if (!resolver) {
      const state = await this.stateStore.getExecutionState(executionId);
      if (state && state.status === 'waiting') {
        await this.resumeExecution(executionId);
      }
    }
  }

  /**
   * Resume a specific execution that was waiting for a human decision.
   * Re-runs the workflow from scratch; the workflow should use checkpoint-replay
   * to skip already-completed steps and pick up from the awaitHuman point.
   */
  async resumeExecution(executionId: string): Promise<unknown> {
    const state = await this.stateStore.getExecutionState(executionId);
    if (!state) {
      throw new Error(`No execution state found for "${executionId}"`);
    }

    const workflow = this.workflows.get(state.workflow);
    if (!workflow) {
      throw new Error(
        `Workflow "${state.workflow}" not registered. Cannot resume execution "${executionId}".`,
      );
    }

    // Re-execute the workflow with the same input — checkpoint-replay will skip completed steps
    return this.execute(state.workflow, state.input, {
      metadata: { ...state.metadata, resumedFrom: executionId, resumeMode: true },
    });
  }

  /**
   * Resume all pending executions that were waiting for human decisions.
   * Call this on startup to resume workflows that were interrupted by a restart.
   * Returns the execution IDs that were resumed.
   */
  async resumePending(): Promise<string[]> {
    const pendingIds = await this.stateStore.listPendingExecutions();
    const resumed: string[] = [];

    for (const executionId of pendingIds) {
      try {
        await this.resumeExecution(executionId);
        resumed.push(executionId);
      } catch (err) {
        this.emit('error', {
          type: 'resume_failed',
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return resumed;
  }

  /**
   * Summarize a list of chat messages into a concise summary string.
   * Used by Session to summarize dropped messages when history.summarize is enabled.
   */
  async summarizeMessages(messages: ChatMessage[], modelUri: string): Promise<string> {
    const { provider, model } = this.providerRegistry.resolve(modelUri, this.config);
    const response = await provider.chat(
      [
        {
          role: 'system',
          content:
            'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation.',
        },
        {
          role: 'user',
          content: messages.map((m) => `${m.role}: ${m.content}`).join('\n'),
        },
      ],
      { model, maxTokens: 1024 },
    );
    return response.content;
  }

  /** Get the state store (for testing and advanced use cases). */
  getStateStore(): StateStore {
    return this.stateStore;
  }

  /**
   * Run an evaluation against a registered workflow.
   * Requires `axl-eval` as a peer dependency.
   *
   * @see Spec Section 13.5
   */
  async eval(
    config: {
      workflow: string;
      dataset: unknown;
      scorers: unknown[];
      concurrency?: number;
      budget?: string;
      metadata?: Record<string, unknown>;
    },
    options?: {
      onProgress?: (event: EvalProgressEventShape) => void;
      signal?: AbortSignal;
      captureTraces?: boolean;
    },
  ): Promise<unknown> {
    let runEvalFn: (
      config: unknown,
      executeFn: (
        input: unknown,
        runtime: unknown,
      ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
      runtime: unknown,
      evalOptions?: {
        onProgress?: (event: EvalProgressEventShape) => void;
        signal?: AbortSignal;
        captureTraces?: boolean;
      },
    ) => Promise<unknown>;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ runEval: runEvalFn } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.eval(). Install it with: npm install @axlsdk/eval',
      );
    }

    const executeWorkflow = async (
      input: unknown,
    ): Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }> => {
      const { result, cost, metadata } = await this.trackExecution(async () => {
        return this.execute(config.workflow, input);
      });
      return { output: result, cost, metadata };
    };

    return runEvalFn(config, executeWorkflow, this, options);
  }

  /**
   * Compare two evaluation results to detect regressions and improvements.
   * Requires `axl-eval` as a peer dependency.
   *
   * @see Spec Section 13.6
   */
  async evalCompare(baseline: unknown, candidate: unknown, options?: unknown): Promise<unknown> {
    let evalCompareFn: (baseline: unknown, candidate: unknown, options?: unknown) => unknown;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ evalCompare: evalCompareFn } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.evalCompare(). Install it with: npm install @axlsdk/eval',
      );
    }

    return evalCompareFn(baseline, candidate, options);
  }

  /**
   * Track cost across any runtime operations within the given function.
   * Uses AsyncLocalStorage to scope cost attribution to specific execution IDs,
   * making it correct with concurrent calls.
   *
   * Works with both `createContext()` and `execute()` calls inside `fn`.
   */
  async trackCost<T>(fn: () => Promise<T>): Promise<{ result: T; cost: number }> {
    const { result, cost } = await this.trackExecution(fn);
    return { result, cost };
  }

  /**
   * Track cost and execution metadata across any runtime operations within the given function.
   * Uses AsyncLocalStorage to scope attribution to specific execution IDs,
   * making it correct with concurrent calls.
   *
   * Returns cost (same as `trackCost`) plus metadata extracted from trace events:
   * models (unique URIs), tokens (input/output/reasoning sums), and agent call count.
   *
   * ## Cost vs tokens semantics
   *
   * - `cost` is the full aggregate across EVERY event with a top-level
   *   `event.cost` set: agent calls, tool calls, semantic memory ops, etc.
   *   This is the number to reconcile against your provider bill.
   *
   * - `metadata.tokens` is narrowly scoped to **agent** prompt/completion/
   *   reasoning tokens. Embedder tokens from semantic `ctx.remember({embed:true})`
   *   / `ctx.recall({query})` are deliberately NOT summed here — they're a
   *   different category (input-only, different pricing, different model).
   *   Conflating them would make "prompt tokens" misleading in the UI. If you
   *   need embedder token counts, subscribe to `runtime.on('trace', ...)` and
   *   read `data.usage.tokens` on `memory_remember` / `memory_recall` events.
   *
   * Pass `{ captureTraces: true }` to also collect the raw `AxlEvent[]` observed
   * during `fn()`. This is opt-in because it keeps every event in memory for the
   * duration of the call — useful for eval per-item capture, debugging, and test
   * assertions, but overhead grows with trace volume. When enabled, verbose-mode
   * `agent_call.data.messages` snapshots are omitted from captured events (still
   * broadcast via onTrace) to keep memory bounded — callers who need the full
   * verbose snapshot should subscribe to `runtime.on('trace', ...)` directly.
   *
   * Works with both `createContext()` and `execute()` calls inside `fn`.
   */
  async trackExecution<T>(
    fn: () => Promise<T>,
    options?: { captureTraces?: boolean },
  ): Promise<{
    result: T;
    cost: number;
    traces?: AxlEvent[];
    metadata: {
      models: string[];
      modelCallCounts?: Record<string, number>;
      /**
       * Agent token totals only — does not include embedder tokens from
       * semantic memory operations. See the method-level JSDoc above.
       */
      tokens: { input: number; output: number; reasoning: number };
      agentCalls: number;
      /**
       * Unique workflow names observed during execution, ordered by first
       * appearance (outermost first for nested calls). Captured automatically
       * from `workflow_start` trace events — callers don't need to declare
       * anything. Parallel mechanism to `models`.
       */
      workflows: string[];
      /** Call counts per workflow, if workflows.length > 0. */
      workflowCallCounts?: Record<string, number>;
    };
  }> {
    const parentScope = costScopeStorage.getStore();
    const scope: CostScope = {
      totalCost: 0,
      trackedIds: new Set(),
      parent: parentScope,
    };

    const modelCalls = new Map<string, number>();
    // Insertion-ordered Map: first time we see a workflow it gets added at
    // the end, so iteration order is "first-seen first" — which for nested
    // workflow calls puts the outermost workflow first.
    const workflowCalls = new Map<string, number>();
    const tokens = { input: 0, output: 0, reasoning: 0 };
    let agentCalls = 0;
    const capturedTraces: AxlEvent[] | undefined = options?.captureTraces ? [] : undefined;

    const listener = (event: AxlEvent) => {
      if (!scope.trackedIds.has(event.executionId)) return;
      if (event.cost) scope.totalCost += event.cost;
      if (event.type === 'agent_call_end') {
        if (event.model) modelCalls.set(event.model, (modelCalls.get(event.model) ?? 0) + 1);
        agentCalls++;
        if (event.tokens) {
          tokens.input += event.tokens.input ?? 0;
          tokens.output += event.tokens.output ?? 0;
          tokens.reasoning += event.tokens.reasoning ?? 0;
        }
      }
      // Both `runtime.execute()` and `runtime.stream()` now emit workflow_start
      // as a first-class `type: 'workflow_start'` event. AxlTestRuntime does
      // the same. The prior log-form fallback is no longer needed.
      if (event.type === 'workflow_start' && event.workflow) {
        workflowCalls.set(event.workflow, (workflowCalls.get(event.workflow) ?? 0) + 1);
      }

      // Capture a compact copy of the event when requested. We strip the
      // verbose `messages` field (can be tens of KB per turn) to keep memory
      // predictable — callers who need the full verbose snapshot should
      // subscribe to `runtime.on('trace', ...)` directly.
      if (capturedTraces) {
        if (event.type === 'agent_call_end' && event.data) {
          const d = event.data as Record<string, unknown>;
          if ('messages' in d) {
            // Strip the verbose messages array by rebuilding without it.
            const rest: Record<string, unknown> = {};
            for (const k of Object.keys(d)) {
              if (k !== 'messages') rest[k] = d[k];
            }
            capturedTraces.push({ ...event, data: rest } as AxlEvent);
            return;
          }
        }
        capturedTraces.push(event);
      }
    };

    // Temporarily increase maxListeners to avoid warnings at high concurrency
    this.setMaxListeners(this.getMaxListeners() + 1);
    this.on('trace', listener);
    try {
      const result = await costScopeStorage.run(scope, fn);
      return {
        result,
        cost: scope.totalCost,
        ...(capturedTraces ? { traces: capturedTraces } : {}),
        metadata: {
          models: [...modelCalls.keys()],
          modelCallCounts: modelCalls.size > 0 ? Object.fromEntries(modelCalls) : undefined,
          tokens,
          agentCalls,
          workflows: [...workflowCalls.keys()],
          workflowCallCounts:
            workflowCalls.size > 0 ? Object.fromEntries(workflowCalls) : undefined,
        },
      };
    } catch (err) {
      // Attach captured traces to the thrown error so callers using
      // `captureTraces: true` can recover the diagnostic trail on failure
      // (e.g., eval runner per-item traces for failed items). Non-enumerable
      // so the property doesn't pollute JSON serialization or stack traces.
      if (capturedTraces && typeof err === 'object' && err !== null) {
        Object.defineProperty(err, 'axlCapturedTraces', {
          value: capturedTraces,
          enumerable: false,
          writable: true,
          configurable: true,
        });
      }
      throw err;
    } finally {
      this.off('trace', listener);
      this.setMaxListeners(this.getMaxListeners() - 1);
    }
  }

  /** Register an execution ID with the active cost scope for trackCost() attribution. */
  private registerWithCostScope(executionId: string): void {
    const costScope = costScopeStorage.getStore();
    if (costScope) {
      let scope: CostScope | undefined = costScope;
      while (scope) {
        scope.trackedIds.add(executionId);
        scope = scope.parent;
      }
    }
  }

  /**
   * Handle trace event output based on configuration.
   *
   * When trace is disabled or level is 'off', events are still emitted via
   * EventEmitter (for programmatic subscribers) but nothing is logged to console.
   * The emit('trace', event) call happens before this method is called, so
   * programmatic subscribers always receive events regardless of trace config.
   */
  private outputAxlEvent(event: AxlEvent): void {
    const traceConfig = this.config.trace;
    if (!traceConfig?.enabled) return;

    const level = traceConfig.level ?? 'steps';
    if (level === 'off') return;

    const output = traceConfig.output ?? 'console';

    if (output === 'json') {
      console.log(JSON.stringify(event));
      return;
    }

    if (output === 'file') {
      const filename = `axl-trace-${event.executionId}.jsonl`;
      try {
        appendFileSync(filename, JSON.stringify(event) + '\n');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          mkdirSync(dirname(filename), { recursive: true });
          appendFileSync(filename, JSON.stringify(event) + '\n');
        } else {
          throw err;
        }
      }
      return;
    }

    // Console output (default)
    this.logAxlEvent(event);
  }

  private logAxlEvent(event: AxlEvent): void {
    const level = this.config.trace?.level ?? 'steps';
    const workflowPrefix = event.workflow ? `workflow:${event.workflow} | ` : '';
    const parts = [`[axl] execution:${event.executionId}`];

    if (event.type === 'workflow_start') {
      // workflow name now lives on the event top-level, not in data.
      parts.push(`${workflowPrefix}started`);
    } else if (event.type === 'workflow_end') {
      // Honour the actual outcome — previously this always said "completed"
      // even for failed/aborted runs.
      const d = event.data as { status?: string; aborted?: boolean } | undefined;
      const status = d?.aborted ? 'aborted' : (d?.status ?? 'completed');
      parts.push(`${workflowPrefix}${status}`);
      if (event.duration != null) parts.push(`${(event.duration / 1000).toFixed(1)}s`);
    } else if (event.type === 'agent_call_end') {
      parts.push(`${workflowPrefix}step:${event.step} agent_call`);
      if (event.agent) parts.push(`agent:${event.agent}`);
      if (event.promptVersion) parts.push(`version:${event.promptVersion}`);
      if (event.model) parts.push(`model:${event.model}`);
      if (event.duration) parts.push(`${(event.duration / 1000).toFixed(1)}s`);
      if (event.cost) parts.push(`$${event.cost.toFixed(3)}`);
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
      }
    } else if (event.type === 'tool_call_end') {
      parts.push(`${workflowPrefix}step:${event.step} tool_call`);
      if (event.tool) parts.push(`tool:${event.tool}`);
      if (event.duration) parts.push(`${event.duration}ms`);
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
      }
    } else if (event.type === 'guardrail') {
      const gData = event.data as
        | { guardrailType?: string; blocked?: boolean; reason?: string }
        | undefined;
      parts.push(`${workflowPrefix}step:${event.step} guardrail`);
      if (gData?.guardrailType) parts.push(`type:${gData.guardrailType}`);
      if (gData?.blocked !== undefined) parts.push(gData.blocked ? 'BLOCKED' : 'passed');
      if (gData?.reason) parts.push(`reason:${gData.reason}`);
    } else if (event.type === 'log') {
      parts.push(`${workflowPrefix}log: ${JSON.stringify(event.data)}`);
    } else {
      parts.push(`${workflowPrefix}${event.type}`);
      // Some variants don't carry `data` (e.g., `ask_start`, `agent_call_start`).
      // Inspect dynamically so the logger remains a catch-all without
      // enumerating every variant.
      const data = (event as { data?: unknown }).data;
      if (level === 'full' && data !== undefined) {
        parts.push(`data:${JSON.stringify(data)}`);
      }
    }

    console.log(parts.join(' | '));
  }

  /**
   * Append a handoff record to session metadata.
   * Note: The read-modify-write is not atomic. Concurrent handoffs in the same
   * session could lose a record. In practice, trace events within a single
   * execution are sequential (same event loop), so this is only a concern for
   * cross-execution concurrency on the same session, which is unlikely.
   */
  private appendHandoffRecord(sessionId: string, record: HandoffRecord): void {
    // Fire and forget — don't block the trace handler
    this.stateStore
      .getSessionMeta(sessionId, 'handoffHistory')
      .then((existing) => {
        const history = (existing as HandoffRecord[]) ?? [];
        history.push(record);
        return this.stateStore.saveSessionMeta(sessionId, 'handoffHistory', history);
      })
      .catch(() => {
        // Silently ignore persistence errors in the trace path
      });
  }
}
