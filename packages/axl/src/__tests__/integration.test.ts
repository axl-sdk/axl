import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const calculatorTool = tool({
  name: 'calculator',
  description:
    'Performs basic arithmetic. Accepts an expression like "2 + 3" and returns the numeric result.',
  input: z.object({
    expression: z.string().describe('A simple arithmetic expression, e.g. "2 + 3"'),
  }),
  handler: ({ expression }) => {
    // Simple eval for basic arithmetic only (safe for tests)
    const sanitized = expression.replace(/[^0-9+\-*/().  ]/g, '');
    try {
      const result = new Function(`return (${sanitized})`)() as number;
      return { result };
    } catch {
      return { error: `Could not evaluate: ${expression}` };
    }
  },
});

// ---------------------------------------------------------------------------
// OpenAI Integration Tests
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAI Integration', () => {
  const cheapModel = 'openai:gpt-4.1-nano';

  it('basic text response', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
    });

    const result = await assistant.ask('What is the capital of France?');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain('paris');
  }, 30_000);

  it('tool calling', async () => {
    const mathAgent = agent({
      model: cheapModel,
      system:
        'You are a math assistant. Always use the calculator tool to compute arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const runtime = new AxlRuntime();

    const mathWorkflow = workflow({
      name: 'math',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        const answer = await ctx.ask(mathAgent, ctx.input.question);
        return answer;
      },
    });

    runtime.register(mathWorkflow);
    const result = await runtime.execute('math', { question: 'What is 7 * 8?' });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('56');
  }, 30_000);

  it('streaming', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short.',
    });

    const streamWorkflow = workflow({
      name: 'stream-test',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(assistant, ctx.input.prompt);
      },
    });

    const runtime = new AxlRuntime();
    runtime.register(streamWorkflow);

    const stream = runtime.stream('stream-test', {
      prompt: 'Say exactly: "Hello from streaming"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') {
        tokens.push(event.data);
      }
    }

    // We should have received at least one token
    expect(tokens.length).toBeGreaterThan(0);

    // The result should be available
    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);

    // fullText should match the concatenation of all tokens
    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);

  it('structured output with Zod schema', async () => {
    const structuredAgent = agent({
      model: cheapModel,
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema.',
    });

    const CitySchema = z.object({
      name: z.string(),
      country: z.string(),
      population: z.number(),
    });

    const runtime = new AxlRuntime();

    const structuredWorkflow = workflow({
      name: 'structured',
      input: z.object({ prompt: z.string() }),
      output: CitySchema,
      handler: async (ctx) => {
        return ctx.ask(structuredAgent, ctx.input.prompt, {
          schema: CitySchema,
          retries: 1,
        });
      },
    });

    runtime.register(structuredWorkflow);

    const result = await runtime.execute('structured', {
      prompt: 'Give me information about Tokyo, Japan. Estimate the population as a number.',
    });

    // Result should be a parsed object matching the schema
    const parsed = CitySchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('tokyo');
      expect(parsed.data.country.toLowerCase()).toContain('japan');
      expect(parsed.data.population).toBeGreaterThan(0);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// OpenAI Responses API Integration Tests
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAI Responses API Integration', () => {
  const cheapModel = 'openai-responses:gpt-4.1-nano';

  it('basic text response', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
    });

    const result = await assistant.ask('What is the capital of Italy?');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain('rome');
  }, 30_000);

  it('tool calling', async () => {
    const mathAgent = agent({
      model: cheapModel,
      system:
        'You are a math assistant. Always use the calculator tool to compute arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const runtime = new AxlRuntime();

    const mathWorkflow = workflow({
      name: 'math-responses',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        const answer = await ctx.ask(mathAgent, ctx.input.question);
        return answer;
      },
    });

    runtime.register(mathWorkflow);
    const result = await runtime.execute('math-responses', { question: 'What is 6 * 9?' });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('54');
  }, 30_000);

  it('streaming', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short.',
    });

    const streamWorkflow = workflow({
      name: 'stream-test-responses',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(assistant, ctx.input.prompt);
      },
    });

    const runtime = new AxlRuntime();
    runtime.register(streamWorkflow);

    const stream = runtime.stream('stream-test-responses', {
      prompt: 'Say exactly: "Hello from Responses API"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') {
        tokens.push(event.data);
      }
    }

    expect(tokens.length).toBeGreaterThan(0);

    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);

    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);

  it('structured output with Zod schema', async () => {
    const structuredAgent = agent({
      model: cheapModel,
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema.',
    });

    const CitySchema = z.object({
      name: z.string(),
      country: z.string(),
      population: z.number(),
    });

    const runtime = new AxlRuntime();

    const structuredWorkflow = workflow({
      name: 'structured-responses',
      input: z.object({ prompt: z.string() }),
      output: CitySchema,
      handler: async (ctx) => {
        return ctx.ask(structuredAgent, ctx.input.prompt, {
          schema: CitySchema,
        });
      },
    });

    runtime.register(structuredWorkflow);

    const result = await runtime.execute('structured-responses', {
      prompt: 'Give me information about London, UK. Estimate the population as a number.',
    });

    const parsed = CitySchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('london');
      expect(parsed.data.country.toLowerCase()).toMatch(/uk|united kingdom|england/);
      expect(parsed.data.population).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Anthropic Integration Tests
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Anthropic Integration', () => {
  const cheapModel = 'anthropic:claude-haiku-4-5';

  it('basic text response', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
    });

    const result = await assistant.ask('What is the capital of Germany?');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain('berlin');
  }, 30_000);

  it('tool calling', async () => {
    const mathAgent = agent({
      model: cheapModel,
      system:
        'You are a math assistant. Always use the calculator tool to compute arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const runtime = new AxlRuntime();

    const mathWorkflow = workflow({
      name: 'math-anthropic',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        const answer = await ctx.ask(mathAgent, ctx.input.question);
        return answer;
      },
    });

    runtime.register(mathWorkflow);
    const result = await runtime.execute('math-anthropic', { question: 'What is 12 * 5?' });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('60');
  }, 30_000);

  it('streaming', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short.',
    });

    const streamWorkflow = workflow({
      name: 'stream-test-anthropic',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(assistant, ctx.input.prompt);
      },
    });

    const runtime = new AxlRuntime();
    runtime.register(streamWorkflow);

    const stream = runtime.stream('stream-test-anthropic', {
      prompt: 'Say exactly: "Hello from Anthropic streaming"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') {
        tokens.push(event.data);
      }
    }

    expect(tokens.length).toBeGreaterThan(0);

    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);

    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Google Gemini Integration Tests
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.GOOGLE_API_KEY)('Google Gemini Integration', () => {
  const cheapModel = 'google:gemini-2.0-flash';

  it('basic text response', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
    });

    const result = await assistant.ask('What is the capital of Japan?');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain('tokyo');
  }, 30_000);

  it('tool calling', async () => {
    const mathAgent = agent({
      model: cheapModel,
      system:
        'You are a math assistant. Always use the calculator tool to compute arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const runtime = new AxlRuntime();

    const mathWorkflow = workflow({
      name: 'math-gemini',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        const answer = await ctx.ask(mathAgent, ctx.input.question);
        return answer;
      },
    });

    runtime.register(mathWorkflow);
    const result = await runtime.execute('math-gemini', { question: 'What is 9 * 7?' });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('63');
  }, 30_000);

  it('multi-turn tool loop', async () => {
    const mathAgent = agent({
      model: cheapModel,
      system:
        'You are a math assistant. You MUST use the calculator tool for every arithmetic operation. To compute (7 * 8) + (3 * 5), first compute 7 * 8, then compute 3 * 5, then compute the sum. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const runtime = new AxlRuntime();

    const multiTurnWorkflow = workflow({
      name: 'multi-turn-gemini',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(mathAgent, ctx.input.question);
      },
    });

    runtime.register(multiTurnWorkflow);
    const result = await runtime.execute('multi-turn-gemini', {
      question: 'What is (7 * 8) + (3 * 5)? Use the calculator for each step.',
    });

    expect(typeof result).toBe('string');
    // 7*8=56, 3*5=15, 56+15=71
    expect(String(result)).toContain('71');
  }, 30_000);

  it('streaming', async () => {
    const assistant = agent({
      model: cheapModel,
      system: 'You are a helpful assistant. Keep answers very short.',
    });

    const streamWorkflow = workflow({
      name: 'stream-test-gemini',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(assistant, ctx.input.prompt);
      },
    });

    const runtime = new AxlRuntime();
    runtime.register(streamWorkflow);

    const stream = runtime.stream('stream-test-gemini', {
      prompt: 'Say exactly: "Hello from Gemini streaming"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') {
        tokens.push(event.data);
      }
    }

    expect(tokens.length).toBeGreaterThan(0);

    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);

    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);

  it('structured output with Zod schema', async () => {
    const structuredAgent = agent({
      model: cheapModel,
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema.',
    });

    const CitySchema = z.object({
      name: z.string(),
      country: z.string(),
      population: z.number(),
    });

    const runtime = new AxlRuntime();

    const structuredWorkflow = workflow({
      name: 'structured-gemini',
      input: z.object({ prompt: z.string() }),
      output: CitySchema,
      handler: async (ctx) => {
        return ctx.ask(structuredAgent, ctx.input.prompt, {
          schema: CitySchema,
        });
      },
    });

    runtime.register(structuredWorkflow);

    const result = await runtime.execute('structured-gemini', {
      prompt: 'Give me information about Paris, France. Estimate the population as a number.',
    });

    const parsed = CitySchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('paris');
      expect(parsed.data.country.toLowerCase()).toContain('france');
      expect(parsed.data.population).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// End-to-End Workflow Test
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)('End-to-end workflow', () => {
  it('workflow with ctx.ask(), tool use, output schema, and traces', async () => {
    const SummarySchema = z.object({
      answer: z.number(),
      explanation: z.string(),
    });

    const mathAgent = agent({
      model: 'openai:gpt-4.1-nano',
      system:
        'You are a math assistant. Use the calculator tool to compute results. Then return a JSON object with "answer" (number) and "explanation" (string).',
      tools: [calculatorTool],
    });

    const mathWorkflow = workflow({
      name: 'math-e2e',
      input: z.object({ question: z.string() }),
      output: SummarySchema,
      handler: async (ctx) => {
        const result = await ctx.ask(mathAgent, ctx.input.question, {
          schema: SummarySchema,
        });
        return result;
      },
    });

    const runtime = new AxlRuntime();
    runtime.register(mathWorkflow);

    // Collect trace events
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => {
      traces.push(event);
    });

    const result = await runtime.execute('math-e2e', {
      question: 'What is 15 + 27? Use the calculator.',
    });

    // Validate output matches schema
    const parsed = SummarySchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.answer).toBe(42);
      expect(typeof parsed.data.explanation).toBe('string');
      expect(parsed.data.explanation.length).toBeGreaterThan(0);
    }

    // Verify traces were emitted
    expect(traces.length).toBeGreaterThan(0);

    // Should have workflow_start and workflow_end
    const workflowStart = traces.find(
      (t) => t.type === 'log' && (t.data as any)?.workflow === 'math-e2e',
    );
    expect(workflowStart).toBeDefined();

    // Should have at least one agent_call trace
    const agentCalls = traces.filter((t) => t.type === 'agent_call_end');
    expect(agentCalls.length).toBeGreaterThan(0);

    // Should have at least one tool_call trace (calculator was used)
    const toolCalls = traces.filter((t) => t.type === 'tool_call_end');
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls.some((t) => t.tool === 'calculator')).toBe(true);

    // All traces should share the same executionId
    const execId = traces[0].executionId;
    expect(traces.every((t) => t.executionId === execId)).toBe(true);
  }, 30_000);
});
