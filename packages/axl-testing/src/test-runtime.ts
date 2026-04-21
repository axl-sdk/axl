import { MockProvider } from './mock-provider.js';
import { MockTool } from './mock-tool.js';
import type {
  AxlEvent,
  AwaitHumanOptions,
  HumanDecision,
  ProviderResponse,
  AgentCallInfo,
  AxlConfig,
} from '@axlsdk/axl';
import { WorkflowContext, MemoryStore, ProviderRegistry, eventCostContribution } from '@axlsdk/axl';
import type { WorkflowContextInit } from '@axlsdk/axl';

// `WorkflowContext<any>` here (rather than `<unknown>`) is load-bearing:
// function parameters are contravariant under strict types, so a
// `Workflow<TInput=MsgType>` whose handler takes `WorkflowContext<MsgType>`
// would otherwise fail to satisfy `WorkflowLike` at `register()` call sites.
// The test runtime never touches the input-shape narrowly; `any` here is
// the standard bivariant-parameter workaround.

interface WorkflowLike {
  readonly name: string;
  readonly inputSchema: { parse: (input: unknown) => unknown };
  readonly outputSchema: { parse: (input: unknown) => unknown } | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: (ctx: WorkflowContext<any>) => Promise<unknown>;
}

export type RecordedToolCall = { name: string; args: unknown; result: unknown };
export type RecordedAgentCall = Partial<AgentCallInfo> &
  Pick<AgentCallInfo, 'agent' | 'prompt' | 'response'>;
export type RecordedStep = { step: number; type: string; data: unknown };

function generateExecutionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type AxlTestRuntimeOptions = {
  record?: string;
  humanDecisions?: (options: AwaitHumanOptions) => HumanDecision;
  /** AxlConfig for the test runtime. Controls trace level/redact, context management, etc.
   *  Defaults to `{}`. Set `{ trace: { level: 'full' } }` to verify verbose-mode snapshots
   *  in tests, or `{ trace: { redact: true } }` to verify redaction policy in tests. */
  config?: AxlConfig;
};

export class AxlTestRuntime {
  private workflows = new Map<string, WorkflowLike>();
  private mockProviders = new Map<string, MockProvider>();
  private mockToolMap = new Map<string, MockTool>();
  private _toolCalls: RecordedToolCall[] = [];
  private _agentCalls: RecordedAgentCall[] = [];
  private _steps: RecordedStep[] = [];
  private _traceLog: AxlEvent[] = [];
  private _totalCost = 0;
  private _stepCounter = 0;
  private recordPath?: string;
  private recorded: ProviderResponse[] = [];
  private _executionId: string = generateExecutionId();
  private _humanDecisionHandler?: (options: AwaitHumanOptions) => HumanDecision;
  private _config: AxlConfig;

  constructor(options?: AxlTestRuntimeOptions) {
    this.recordPath = options?.record;
    this._humanDecisionHandler = options?.humanDecisions;
    this._config = options?.config ?? {};
  }

  register(workflow: WorkflowLike): void {
    this.workflows.set(workflow.name, workflow);
  }

  mockProvider(name: string, provider: MockProvider): void {
    this.mockProviders.set(name, provider);
  }

  mockTool(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void {
    this.mockToolMap.set(name, MockTool.create(name, handler));
  }

  async execute(
    workflowName: string,
    input: unknown,
    options?: { metadata?: Record<string, unknown> },
  ): Promise<unknown> {
    const workflow = this.workflows.get(workflowName);
    if (!workflow) throw new Error(`Workflow "${workflowName}" not registered`);

    // Reset state between executions
    this._toolCalls = [];
    this._agentCalls = [];
    this._steps = [];
    this._traceLog = [];
    this._totalCost = 0;
    this._stepCounter = 0;
    this.recorded = [];
    this._executionId = generateExecutionId();

    const validated = workflow.inputSchema.parse(input);

    // Build ProviderRegistry from registered mock providers
    const registry = new ProviderRegistry();
    registry.clearFactories(); // Remove built-in factories; only use explicit mocks
    for (const [name, provider] of this.mockProviders) {
      registry.registerInstance(name, provider);
    }
    // Fallback resolution: 'default' key or single-provider
    const defaultProvider = this.mockProviders.get('default');
    if (defaultProvider) {
      registry.setFallback(defaultProvider);
    } else if (this.mockProviders.size === 1) {
      const onlyProvider = this.mockProviders.values().next().value!;
      registry.setFallback(onlyProvider);
    }

    // Build toolOverrides from mockToolMap
    const toolOverrides = new Map<string, (args: unknown) => Promise<unknown>>();
    for (const [name, mockTool] of this.mockToolMap) {
      toolOverrides.set(name, async (args: unknown) => {
        return mockTool.execute(args);
      });
    }

    // Previously `_recordStep('workflow_start', ...)` was called here with
    // raw `{ workflow, input }` data, AND `ctx._emitWorkflowStart` below
    // pushed through the onTrace handler (which also bumps `_stepCounter`
    // and appends to `_steps`). Result: two entries in `steps()` per
    // workflow_start, with the first bypassing `config.trace.redact`.
    // The `_recordStep` call is removed — onTrace is the single source
    // of truth for `_steps`, matching the behavior of every other event
    // type in the test runtime. Reviewer architecture §5.

    const init: WorkflowContextInit = {
      input: validated,
      executionId: this._executionId,
      metadata: options?.metadata,
      // Thread the constructor-provided config so tests can exercise
      // trace.level === 'full' and trace.redact behavior end-to-end.
      config: this._config,
      // Production runtime threads this (see `runtime.ts:594` in
      // `execute()` and `:765` in `stream()`). `emitEvent` auto-stamps
      // `event.workflow` from it, so consumers grouping by workflow
      // (Cost Dashboard `byWorkflow`, `trackExecution.metadata.workflows`,
      // any eval runner) see the same attribution in tests and prod.
      workflowName,
      providerRegistry: registry,
      stateStore: new MemoryStore(),
      toolOverrides: toolOverrides.size > 0 ? toolOverrides : undefined,
      awaitHumanHandler: this._humanDecisionHandler
        ? (opts: AwaitHumanOptions) => this._humanDecisionHandler!(opts)
        : undefined,
      onTrace: (event: AxlEvent) => {
        this._traceLog.push(event);
        this._stepCounter++;
        this._steps.push({
          step: this._stepCounter,
          type: event.type,
          data: (event as { data?: unknown }).data,
        });

        if (event.type === 'tool_call_end' && event.data) {
          const { args, result } = event.data as { args: unknown; result: unknown };
          this._toolCalls.push({ name: event.tool!, args, result });
        }

        // Single-source-of-truth cost accumulator. Skips ask_end
        // rollups (decision 10) and guards NaN/Infinity.
        this._totalCost += eventCostContribution(event);

        // Track provider responses for recording
        if (event.type === 'agent_call_end' && event.data) {
          const { response } = event.data as { prompt?: string; response?: string };
          if (response !== undefined) {
            this.recorded.push({
              content: response,
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              cost: event.cost ?? 0,
            });
          }
        }
      },
      onAgentCallComplete: (call: AgentCallInfo) => {
        this._agentCalls.push(call);
      },
    };

    const ctx = new WorkflowContext(init);

    // Emit workflow_start through the same pipeline production uses,
    // AFTER ctx exists so `emitEvent`'s redact/step/timestamp handling
    // applies. Previously emitted via `_pushTrace` which bypassed
    // redaction — `config: { trace: { redact: true } }` on the test
    // runtime would scrub intermediate events but leak `input`/`result`
    // through the synthesized workflow_start/end.
    const startedAt = Date.now();
    ctx._emitWorkflowStart(validated);
    try {
      const result = await workflow.handler(ctx);

      // Validate output schema if defined
      if (workflow.outputSchema) workflow.outputSchema.parse(result);

      ctx._emitWorkflowEnd({
        status: 'completed',
        duration: Date.now() - startedAt,
        result,
      });
      // `_steps` is populated by onTrace for every event (including
      // workflow_end); no separate `_recordStep` call needed — that
      // would double-count.

      if (this.recordPath) await this._writeRecording();
      return result;
    } catch (err) {
      // Parity with production: failed workflows get a terminal
      // `workflow_end(status: 'failed')` event so consumers counting
      // workflow_start ↔ workflow_end pairs never see an unclosed one.
      // `aborted` flag mirrors the runtime.ts AbortError detection.
      const aborted =
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === 'AbortError';
      ctx._emitWorkflowEnd({
        status: 'failed',
        duration: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        ...(aborted ? { aborted: true } : {}),
      });
      // `_steps` populated by onTrace (see comment on the success path).
      throw err;
    }
  }

  toolCalls(name?: string): RecordedToolCall[] {
    return name ? this._toolCalls.filter((c) => c.name === name) : this._toolCalls;
  }

  agentCalls(name?: string): RecordedAgentCall[] {
    return name ? this._agentCalls.filter((c) => c.agent === name) : this._agentCalls;
  }

  totalCost(): number {
    return this._totalCost;
  }
  steps(): RecordedStep[] {
    return this._steps;
  }
  traceLog(): AxlEvent[] {
    return this._traceLog;
  }

  private async _writeRecording(): Promise<void> {
    if (!this.recordPath) return;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.recordPath), { recursive: true });
    await writeFile(this.recordPath, JSON.stringify(this.recorded, null, 2), 'utf8');
  }
}
