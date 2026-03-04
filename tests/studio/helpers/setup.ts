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

export function createTestServer(providerOverride?: MockProvider) {
  const runtime = new AxlRuntime();
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

  const { app, connMgr, costAggregator } = createServer({ runtime });

  return { app, runtime, connMgr, costAggregator, provider };
}
