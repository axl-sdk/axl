import { z } from 'zod';
import { tool, agent, workflow, AxlRuntime, type TraceEvent, type Agent } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

/** Create a test runtime with a MockProvider registered as 'mock'. */
export function createTestRuntime(provider?: MockProvider) {
  const runtime = new AxlRuntime();
  const traces: TraceEvent[] = [];
  const mockProvider = provider ?? MockProvider.echo();
  runtime.registerProvider('mock', mockProvider);
  runtime.on('trace', (event: TraceEvent) => {
    traces.push(event);
  });
  return { runtime, traces, provider: mockProvider };
}

/** Simple calculator tool that does basic arithmetic. */
export const calculatorTool = tool({
  name: 'calculator',
  description: 'Evaluate a simple arithmetic expression',
  input: z.object({ expression: z.string() }),
  handler: (input) => {
    // Simple safe evaluation for basic math
    const expr = input.expression.replace(/[^0-9+\-*/().  ]/g, '');
    const result = Function(`"use strict"; return (${expr})`)() as number;
    return String(result);
  },
});

/** Greeting tool for basic tests. */
export const greetTool = tool({
  name: 'greet',
  description: 'Greet someone by name',
  input: z.object({ name: z.string() }),
  handler: (input) => `Hello, ${input.name}!`,
});

/** Create a test agent that uses a mock provider. */
export function testAgent(opts?: { provider?: MockProvider; tools?: (typeof calculatorTool)[] }) {
  return agent({
    name: 'test-agent',
    model: 'mock:test',
    system: 'You are a helpful test assistant.',
    tools: opts?.tools ?? [calculatorTool],
    maxTurns: 10,
  });
}

/** Create a simple test workflow that asks an agent a question. */
export function testWorkflow(agentDef?: Agent) {
  const theAgent = agentDef ?? testAgent();
  return workflow({
    name: 'test-wf',
    input: z.object({ message: z.string() }),
    handler: async (ctx) => {
      const result = await ctx.ask(theAgent, ctx.input.message);
      return result;
    },
  });
}

/** Collect trace events from a runtime. */
export function collectTraces(runtime: AxlRuntime): TraceEvent[] {
  const traces: TraceEvent[] = [];
  runtime.on('trace', (event: TraceEvent) => {
    traces.push(event);
  });
  return traces;
}
