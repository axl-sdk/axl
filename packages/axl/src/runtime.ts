import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AxlConfig } from './config.js';
import { resolveConfig } from './config.js';
import type { Workflow } from './workflow.js';
import type { Tool } from './tool.js';
import type { Agent } from './agent.js';
import type { Provider } from './providers/types.js';
import { ProviderRegistry } from './providers/registry.js';
import type { StateStore, PendingDecision } from './state/types.js';
import { MemoryStore } from './state/memory.js';
import { SQLiteStore } from './state/sqlite.js';
import { RedisStore } from './state/redis.js';
import { WorkflowContext } from './context.js';
import { Session, type SessionOptions } from './session.js';
import { AxlStream } from './stream.js';
import { McpManager } from './mcp/manager.js';
import { MemoryManager } from './memory/manager.js';
import type {
  TraceEvent,
  ExecutionInfo,
  HumanDecision,
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
};

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
      executeWorkflow?: (input: unknown) => Promise<{ output: unknown; cost?: number }>;
    }
  >();
  private mcpManager?: McpManager;
  private memoryManager?: MemoryManager;
  private spanManager: SpanManager = new NoopSpanManager();

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
    const storeType = this.config.state?.store ?? 'memory';
    switch (storeType) {
      case 'sqlite':
        return new SQLiteStore(this.config.state?.sqlite?.path ?? './data/axl.db');
      case 'redis':
        return new RedisStore(this.config.state?.redis?.url);
      case 'memory':
      default:
        return new MemoryStore();
    }
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
    executeWorkflow?: (input: unknown) => Promise<{ output: unknown; cost?: number }>,
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
        executeWorkflow?: (input: unknown) => Promise<{ output: unknown; cost?: number }>;
      }
    | undefined {
    return this.registeredEvals.get(name);
  }

  /** Run a registered eval by name. */
  async runRegisteredEval(name: string): Promise<unknown> {
    const entry = this.registeredEvals.get(name);
    if (!entry) throw new Error(`Eval "${name}" is not registered`);

    if (entry.executeWorkflow) {
      // Use custom executeWorkflow if provided
      let runEvalFn: (
        config: unknown,
        executeFn: (input: unknown) => Promise<{ output: unknown; cost?: number }>,
      ) => Promise<unknown>;
      try {
        // @ts-expect-error — @axlsdk/eval is an optional peer dependency
        ({ runEval: runEvalFn } = await import('@axlsdk/eval'));
      } catch {
        throw new Error(
          'axl-eval is required for AxlRuntime.runRegisteredEval(). Install it with: npm install @axlsdk/eval',
        );
      }
      return runEvalFn(entry.config, entry.executeWorkflow);
    }

    // Default: use runtime.eval() which creates its own executeWorkflow
    return this.eval(
      entry.config as {
        workflow: string;
        dataset: unknown;
        scorers: unknown[];
        concurrency?: number;
        budget?: string;
        metadata?: Record<string, unknown>;
      },
    );
  }

  /** Get all execution info (running + completed). */
  getExecutions(): ExecutionInfo[] {
    return [...this.executions.values()];
  }

  /**
   * Create a lightweight WorkflowContext for ad-hoc use (tool testing, prototyping).
   * The context has access to the runtime's providers, state store, and MCP manager
   * but no session history, streaming callbacks, or budget tracking.
   */
  createContext(options?: { metadata?: Record<string, unknown> }): WorkflowContext {
    return new WorkflowContext({
      input: undefined,
      executionId: randomUUID(),
      metadata: options?.metadata,
      config: this.config,
      providerRegistry: this.providerRegistry,
      stateStore: this.stateStore,
      mcpManager: this.mcpManager,
      spanManager: this.spanManager,
      memoryManager: this.memoryManager,
    });
  }

  /** Register a custom provider instance. */
  registerProvider(name: string, provider: Provider): void {
    this.providerRegistry.registerInstance(name, provider);
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

    // Create execution info
    const execInfo: ExecutionInfo = {
      executionId,
      workflow: name,
      status: 'running',
      steps: [],
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
      onTrace: (event: TraceEvent) => {
        execInfo.steps.push(event);
        if (event.cost) execInfo.totalCost += event.cost;
        this.emit('trace', event);
        this.outputTraceEvent(event);
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
      stateStore: this.stateStore,
      workflowName: name,
      mcpManager: this.mcpManager,
      memoryManager: this.memoryManager,
      resumeMode: !!options?.metadata?.resumeMode,
      spanManager: this.spanManager,
    });

    // Emit workflow start trace
    ctx.log('workflow_start', { workflow: name, executionId });

    return this.spanManager.withSpanAsync(
      'axl.workflow.execute',
      {
        'axl.workflow.name': name,
        'axl.execution.id': executionId,
        'axl.workflow.input_hash': hashInput(validated),
      },
      async (span) => {
        try {
          const result = await workflow.handler(ctx);

          // Validate (and coerce) output if schema exists
          const output = workflow.outputSchema ? workflow.outputSchema.parse(result) : result;

          execInfo.status = 'completed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          ctx.log('workflow_end', {
            workflow: name,
            status: 'completed',
            duration: execInfo.duration,
            cost: execInfo.totalCost,
          });

          // Clean up checkpoints for completed execution
          if (this.stateStore.deleteCheckpoints) {
            await this.stateStore.deleteCheckpoints(executionId);
          }

          span.setAttribute('axl.workflow.cost', execInfo.totalCost);
          span.setAttribute('axl.workflow.duration', execInfo.duration);

          return output;
        } catch (err) {
          execInfo.status = 'failed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.error = err instanceof Error ? err.message : String(err);
          ctx.log('workflow_end', { workflow: name, status: 'failed', error: execInfo.error });
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

    // Execute asynchronously, piping events to the stream
    // execInfo is captured by the closure so the catch handler can update it on error.
    let execInfo: ExecutionInfo | undefined;

    const run = async () => {
      const workflow = this.workflows.get(name);
      if (!workflow) throw new Error(`Workflow "${name}" not registered`);

      const validated = workflow.inputSchema.parse(input);
      const executionId = randomUUID();
      this.abortControllers.set(executionId, controller);
      const sessionHistory = (options?.metadata?.sessionHistory as ChatMessage[]) ?? undefined;

      // Create execution info for stream executions
      execInfo = {
        executionId,
        workflow: name,
        status: 'running',
        steps: [],
        totalCost: 0,
        startedAt: Date.now(),
        duration: 0,
      };
      this.executions.set(executionId, execInfo);

      const ctx = new WorkflowContext({
        input: validated,
        executionId,
        metadata: options?.metadata,
        config: this.config,
        providerRegistry: this.providerRegistry,
        sessionHistory,
        signal: controller.signal,
        onTrace: (event: TraceEvent) => {
          execInfo!.steps.push(event);
          if (event.cost) execInfo!.totalCost += event.cost;
          this.emit('trace', event);
          this.outputTraceEvent(event);
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
          } else if (event.type === 'tool_denied') {
            const data = event.data as Record<string, unknown> | undefined;
            if (data?.denied === false) {
              // Approval succeeded
              axlStream._push({
                type: 'tool_approval',
                name: event.tool ?? '',
                args: data?.args,
                approved: true,
              });
            } else {
              // Approval denied
              axlStream._push({
                type: 'tool_approval',
                name: event.tool ?? '',
                args: data?.args,
                approved: false,
                reason: (data?.reason as string) ?? undefined,
              });
            }
          } else if (event.type === 'agent_call') {
            axlStream._push({
              type: 'agent_end',
              agent: event.agent ?? '',
              cost: event.cost,
              duration: event.duration,
            });
          } else if (event.type === 'tool_call') {
            axlStream._push({
              type: 'tool_result',
              name: event.tool ?? '',
              result: (event.data as Record<string, unknown>)?.result,
            });
          }
          // Always emit raw step event for backwards compat
          axlStream._push({ type: 'step', step: event.step, data: event });
        },
        onToken: (token: string) => {
          axlStream._push({ type: 'token', data: token });
        },
        onToolCall: (call: { name: string; args: unknown }) => {
          axlStream._push({ type: 'tool_call', name: call.name, args: call.args });
        },
        onAgentStart: (info: { agent: string; model: string }) => {
          axlStream._push({ type: 'agent_start', agent: info.agent, model: info.model });
        },
        pendingDecisions: this.pendingDecisionResolvers,
        stateStore: this.stateStore,
        workflowName: name,
        mcpManager: this.mcpManager,
        memoryManager: this.memoryManager,
        resumeMode: !!options?.metadata?.resumeMode,
        spanManager: this.spanManager,
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
            const rawResult = await workflow.handler(ctx);
            const result = workflow.outputSchema
              ? workflow.outputSchema.parse(rawResult)
              : rawResult;

            execInfo!.status = 'completed';
            execInfo!.completedAt = Date.now();
            execInfo!.duration = execInfo!.completedAt - execInfo!.startedAt;

            // Clean up checkpoints for completed execution
            if (this.stateStore.deleteCheckpoints) {
              await this.stateStore.deleteCheckpoints(executionId);
            }

            span.setAttribute('axl.workflow.cost', execInfo!.totalCost);
            span.setAttribute('axl.workflow.duration', execInfo!.duration);

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
          execInfo.status = 'failed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.error = err instanceof Error ? err.message : String(err);
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
    return this.executions.get(executionId);
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
  async eval(config: {
    workflow: string;
    dataset: unknown;
    scorers: unknown[];
    concurrency?: number;
    budget?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    let runEval: (
      config: unknown,
      executeFn: (input: unknown) => Promise<{ output: unknown; cost?: number }>,
    ) => Promise<unknown>;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ runEval } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.eval(). Install it with: npm install @axlsdk/eval',
      );
    }

    const executeWorkflow = async (input: unknown): Promise<{ output: unknown; cost?: number }> => {
      let cost = 0;
      const costListener = (event: TraceEvent) => {
        if (event.cost) cost += event.cost;
      };
      this.on('trace', costListener);
      try {
        const output = await this.execute(config.workflow, input);
        return { output, cost };
      } finally {
        this.off('trace', costListener);
      }
    };

    return runEval(config, executeWorkflow);
  }

  /**
   * Compare two evaluation results to detect regressions and improvements.
   * Requires `axl-eval` as a peer dependency.
   *
   * @see Spec Section 13.6
   */
  async evalCompare(baseline: unknown, candidate: unknown): Promise<unknown> {
    let evalCompareFn: (baseline: unknown, candidate: unknown) => Promise<unknown>;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ evalCompare: evalCompareFn } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.evalCompare(). Install it with: npm install @axlsdk/eval',
      );
    }

    return evalCompareFn(baseline, candidate);
  }

  /**
   * Handle trace event output based on configuration.
   *
   * When trace is disabled or level is 'off', events are still emitted via
   * EventEmitter (for programmatic subscribers) but nothing is logged to console.
   * The emit('trace', event) call happens before this method is called, so
   * programmatic subscribers always receive events regardless of trace config.
   */
  private outputTraceEvent(event: TraceEvent): void {
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
    this.logTraceEvent(event);
  }

  private logTraceEvent(event: TraceEvent): void {
    const level = this.config.trace?.level ?? 'steps';
    const workflowPrefix = event.workflow ? `workflow:${event.workflow} | ` : '';
    const parts = [`[axl] execution:${event.executionId}`];

    const data = event.data as { workflow?: string } | undefined;

    if (event.type === 'workflow_start') {
      parts.push(`${workflowPrefix}workflow:${data?.workflow ?? 'unknown'} | started`);
    } else if (event.type === 'workflow_end') {
      parts.push(`${workflowPrefix}workflow:${data?.workflow ?? 'unknown'} | completed`);
    } else if (event.type === 'agent_call') {
      parts.push(`${workflowPrefix}step:${event.step} agent_call`);
      if (event.agent) parts.push(`agent:${event.agent}`);
      if (event.promptVersion) parts.push(`version:${event.promptVersion}`);
      if (event.model) parts.push(`model:${event.model}`);
      if (event.duration) parts.push(`${(event.duration / 1000).toFixed(1)}s`);
      if (event.cost) parts.push(`$${event.cost.toFixed(3)}`);
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
      }
    } else if (event.type === 'tool_call') {
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
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
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
