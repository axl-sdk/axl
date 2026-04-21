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
import { WorkflowContext, MemoryStore, ProviderRegistry } from '@axlsdk/axl';
import type { WorkflowContextInit } from '@axlsdk/axl';

interface WorkflowLike {
  readonly name: string;
  readonly inputSchema: { parse: (input: unknown) => unknown };
  readonly outputSchema: { parse: (input: unknown) => unknown } | undefined;
  readonly handler: (ctx: WorkflowContext) => Promise<unknown>;
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

    // Record steps and traces via callbacks
    this._recordStep('workflow_start', { workflow: workflowName, input: validated });
    this._pushTrace({
      type: 'workflow_start',
      workflow: workflowName,
      data: { input: validated },
    });

    const init: WorkflowContextInit = {
      input: validated,
      executionId: this._executionId,
      metadata: options?.metadata,
      // Thread the constructor-provided config so tests can exercise
      // trace.level === 'full' and trace.redact behavior end-to-end.
      config: this._config,
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

        // Skip ask_end (per-ask rollup) so we don't double-count the
        // agent_call_end / tool_call_end events that already accumulated.
        // Spec decision 10.
        if (event.cost && event.type !== 'ask_end') {
          this._totalCost += event.cost;
        }

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
    const result = await workflow.handler(ctx);

    // Validate output schema if defined
    if (workflow.outputSchema) workflow.outputSchema.parse(result);

    this._recordStep('workflow_end', { workflow: workflowName, result });
    this._pushTrace({
      type: 'workflow_end',
      workflow: workflowName,
      data: { result },
    });

    if (this.recordPath) await this._writeRecording();
    return result;
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

  private _recordStep(type: string, data: unknown): void {
    this._stepCounter++;
    this._steps.push({ step: this._stepCounter, type, data });
  }

  private _pushTrace(partial: {
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
  }): void {
    // See `WorkflowContext.emitTrace` for the rationale — the loose internal
    // partial type can't be narrowed to a single union member, so we cast
    // through `unknown`. Runtime invariant is maintained by call sites.
    this._traceLog.push({
      executionId: this._executionId,
      step: this._stepCounter,
      timestamp: Date.now(),
      ...partial,
    } as unknown as AxlEvent);
  }

  private async _writeRecording(): Promise<void> {
    if (!this.recordPath) return;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.recordPath), { recursive: true });
    await writeFile(this.recordPath, JSON.stringify(this.recorded, null, 2), 'utf8');
  }
}
