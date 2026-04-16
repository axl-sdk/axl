import { z } from 'zod';
import { AxlRuntime, tool, agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { dataset, scorer } from '@axlsdk/eval';
import { createServer } from '@axlsdk/studio';

export const greetTool = tool({
  name: 'greet',
  description: 'Greet someone by name',
  input: z.object({ name: z.string() }),
  handler: (input) => `Hello, ${input.name}!`,
});

export const testAgent = agent({
  name: 'test-agent',
  model: 'mock:test',
  system: 'You are a helpful test assistant.',
  tools: [greetTool],
});

export function createTestServer(
  providerOverride?: MockProvider,
  serverOptions?: { readOnly?: boolean; redact?: boolean },
) {
  // Only set `redact: true` — leave `trace.enabled` at the config default
  // so redact-on tests don't unexpectedly activate console trace output
  // and spam test logs. `runtime.isRedactEnabled()` reads the flag
  // directly and doesn't require `enabled: true`.
  const runtime = new AxlRuntime(serverOptions?.redact ? { trace: { redact: true } } : undefined);
  const provider = providerOverride ?? MockProvider.echo();
  runtime.registerProvider('mock', provider);

  runtime.registerTool(greetTool);
  runtime.registerAgent(testAgent);

  // Workflow with object input (for /api/workflows/:name/execute)
  const wf = workflow({
    name: 'test-wf',
    input: z.object({ message: z.string() }),
    handler: async (ctx) => ctx.ask(testAgent, ctx.input.message),
  });
  runtime.register(wf);

  // Workflow with string input (for sessions and playground which pass raw strings)
  const chatWf = workflow({
    name: 'chat-wf',
    input: z.string(),
    handler: async (ctx) => ctx.ask(testAgent, ctx.input),
  });
  runtime.register(chatWf);

  // Register a test eval config
  const testDataset = dataset({
    name: 'test-dataset',
    schema: z.object({ message: z.string() }),
    items: [{ input: { message: 'eval-input' } }],
  });
  const testScorer = scorer({
    name: 'always-pass',
    description: 'Always returns 1',
    score: () => 1,
  });
  runtime.registerEval('test-eval', {
    workflow: 'test-wf',
    dataset: testDataset,
    scorers: [testScorer],
  });

  const server = createServer({
    runtime,
    readOnly: serverOptions?.readOnly,
  });

  return {
    app: server.app,
    runtime,
    connMgr: server.connMgr,
    costAggregator: server.costAggregator,
    workflowStatsAggregator: server.workflowStatsAggregator,
    traceStatsAggregator: server.traceStatsAggregator,
    evalTrendsAggregator: server.evalTrendsAggregator,
    aggregatorStartPromise: server.aggregatorStartPromise,
    provider,
  };
}
