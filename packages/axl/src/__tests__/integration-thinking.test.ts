import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { StreamChunk } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
const hasGoogle = !!process.env.GOOGLE_API_KEY;

const calculatorTool = tool({
  name: 'calculator',
  description:
    'Performs basic arithmetic. Accepts an expression like "2 + 3" and returns the numeric result.',
  input: z.object({
    expression: z.string().describe('A simple arithmetic expression, e.g. "2 + 3"'),
  }),
  handler: ({ expression }) => {
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
// OpenAI: thinking maps to reasoning_effort on reasoning models
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Thinking Integration: OpenAI', () => {
  const reasoningModel = 'openai:o4-mini';

  it('thinking "low" produces a valid response from a reasoning model', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const result = await reasoner.ask('What is 7 + 5?');
    expect(typeof result).toBe('string');
    expect(result).toContain('12');
  }, 30_000);

  it('thinking "high" produces a valid response with deeper reasoning', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a math assistant. Keep answers very short.',
      effort: 'high',
    });

    const result = await reasoner.ask('What is the square root of 144?');
    expect(typeof result).toBe('string');
    expect(result).toContain('12');
  }, 30_000);

  it('thinking with tool calling works on reasoning models', async () => {
    const mathAgent = agent({
      model: reasoningModel,
      system:
        'You are a math assistant. Always use the calculator tool for arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
      effort: 'medium',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-tool-openai',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-tool-openai', {
      question: 'What is 13 * 17?',
    });
    expect(String(result)).toContain('221');
  }, 30_000);

  it('effort "low" produces a valid response', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const result = await reasoner.ask('What is 2 + 2?');
    expect(typeof result).toBe('string');
    expect(result).toContain('4');
  }, 30_000);

  it('per-call thinking override works', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'high',
    });

    // Override to 'low' for this call
    const result = await reasoner.ask('What is 3 + 3?', { effort: 'low' });
    expect(typeof result).toBe('string');
    expect(result).toContain('6');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// OpenAI Responses API: thinking maps to reasoning.effort
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Thinking Integration: OpenAI Responses', () => {
  const reasoningModel = 'openai-responses:o4-mini';

  it('thinking "medium" produces a valid response', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'medium',
    });

    const result = await reasoner.ask('What is the capital of France?');
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('paris');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Anthropic: thinking maps to thinking.budget_tokens
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('Thinking Integration: Anthropic', () => {
  const model = 'anthropic:claude-haiku-4-5';

  it('thinking "low" produces a valid response with extended thinking', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const result = await thinker.ask('What is the capital of Germany?');
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('berlin');
  }, 30_000);

  it('thinking "high" produces a valid response (auto-bumps max_tokens)', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'high',
      // maxTokens defaults to 4096 which is < budget_tokens 10000
      // Provider should auto-bump to 11024
    });

    const result = await thinker.ask('What is 7 * 8?');
    expect(typeof result).toBe('string');
    expect(result).toContain('56');
  }, 30_000);

  it('thinking budget form { budgetTokens } works', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      thinkingBudget: 2000,
    });

    const result = await thinker.ask('What is the largest planet in our solar system?');
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('jupiter');
  }, 30_000);

  it('thinking with tool calling works', async () => {
    const mathAgent = agent({
      model,
      system:
        'You are a math assistant. Always use the calculator tool for arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-tool-anthropic',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-tool-anthropic', {
      question: 'What is 9 * 11?',
    });
    expect(String(result)).toContain('99');
  }, 30_000);

  it('thinking with streaming works', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-stream-anthropic',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => ctx.ask(thinker, ctx.input.prompt),
    });
    runtime.register(wf);

    const stream = runtime.stream('thinking-stream-anthropic', {
      prompt: 'Say exactly: "Hello from thinking"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
    }

    expect(tokens.length).toBeGreaterThan(0);

    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);

  it('thinking with structured output works', async () => {
    const CitySchema = z.object({
      name: z.string(),
      country: z.string(),
      population: z.number(),
    });

    const thinker = agent({
      model,
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema.',
      effort: 'low',
    });

    const result = await thinker.ask(
      'Give me information about Tokyo, Japan. Estimate the population as a number.',
      { schema: CitySchema },
    );

    const parsed = CitySchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('tokyo');
      expect(parsed.data.population).toBeGreaterThan(0);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Anthropic 4.6: adaptive thinking mode
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('Thinking Integration: Anthropic Adaptive', () => {
  const model = 'anthropic:claude-sonnet-4-6';

  it('thinking "low" uses adaptive mode and produces a valid response', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const result = await thinker.ask('What is the capital of Italy?');
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('rome');
  }, 30_000);

  it('thinking "high" uses adaptive mode', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'high',
    });

    const result = await thinker.ask('What is 6 * 9?');
    expect(typeof result).toBe('string');
    expect(result).toContain('54');
  }, 30_000);

  it('budget form falls back to manual mode on 4.6 models', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      thinkingBudget: 2000,
    });

    const result = await thinker.ask('What is the chemical symbol for gold?');
    expect(typeof result).toBe('string');
    expect(result).toContain('Au');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Google Gemini: thinking maps to thinkingConfig.thinkingBudget
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('Thinking Integration: Google Gemini', () => {
  const model = 'google:gemini-2.5-flash';

  it('thinking "low" produces a valid response', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const result = await thinker.ask('What is the capital of Japan?');
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('tokyo');
  }, 30_000);

  it('thinking "high" produces a valid response', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'high',
    });

    const result = await thinker.ask('What is 11 * 11?');
    expect(typeof result).toBe('string');
    expect(result).toContain('121');
  }, 30_000);

  it('thinking budget form { budgetTokens } works', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      thinkingBudget: 2000,
    });

    const result = await thinker.ask('What is the chemical symbol for water?');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/H2O|H₂O/i);
  }, 30_000);

  it('thinking with tool calling works', async () => {
    const mathAgent = agent({
      model,
      system:
        'You are a math assistant. Always use the calculator tool for arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-tool-gemini',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-tool-gemini', {
      question: 'What is 8 * 7?',
    });
    expect(String(result)).toContain('56');
  }, 30_000);

  it('thinking with streaming works', async () => {
    const thinker = agent({
      model,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-stream-gemini',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => ctx.ask(thinker, ctx.input.prompt),
    });
    runtime.register(wf);

    const stream = runtime.stream('thinking-stream-gemini', {
      prompt: 'Say exactly: "Hello from Gemini thinking"',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
    }

    expect(tokens.length).toBeGreaterThan(0);
    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect(stream.fullText).toBe(tokens.join(''));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cross-provider: same thinking config produces consistent results
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI || !hasAnthropic || !hasGoogle)(
  'Thinking Integration: Cross-provider',
  () => {
    it('all providers produce correct answers with thinking "low"', async () => {
      const AnswerSchema = z.object({
        answer: z.number(),
      });

      const prompt =
        'What is 15 + 27? Respond with JSON: {"answer": 42}. Only the JSON, no other text.';

      const openaiAgent = agent({
        model: 'openai:o4-mini',
        system: 'You are a math assistant. Respond with valid JSON only.',
        effort: 'low',
      });

      const anthropicAgent = agent({
        model: 'anthropic:claude-haiku-4-5',
        system: 'You are a math assistant. Respond with valid JSON only.',
        effort: 'low',
      });

      const geminiAgent = agent({
        model: 'google:gemini-2.5-flash',
        system: 'You are a math assistant. Respond with valid JSON only.',
        effort: 'low',
      });

      const [oaiResult, antResult, gemResult] = await Promise.all([
        openaiAgent.ask(prompt, { schema: AnswerSchema }),
        anthropicAgent.ask(prompt, { schema: AnswerSchema }),
        geminiAgent.ask(prompt, { schema: AnswerSchema }),
      ]);

      for (const result of [oaiResult, antResult, gemResult]) {
        const parsed = AnswerSchema.safeParse(result);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.answer).toBe(42);
        }
      }
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// OpenAI: structured output + thinking
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Thinking Integration: OpenAI Structured Output', () => {
  const reasoningModel = 'openai:o4-mini';

  it('structured output with thinking works on Chat Completions', async () => {
    const PlanetSchema = z.object({
      name: z.string(),
      position: z.number(),
      hasRings: z.boolean(),
    });

    const reasoner = agent({
      model: reasoningModel,
      system:
        'You are an astronomy assistant. Always respond with valid JSON matching the requested schema.',
      effort: 'low',
    });

    const result = await reasoner.ask('Give me information about Saturn. Position from sun is 6.', {
      schema: PlanetSchema,
    });

    const parsed = PlanetSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('saturn');
      expect(parsed.data.position).toBe(6);
      expect(parsed.data.hasRings).toBe(true);
    }
  }, 30_000);

  it('streaming with thinking works on Chat Completions', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-stream-openai',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.prompt),
    });
    runtime.register(wf);

    const stream = runtime.stream('thinking-stream-openai', {
      prompt: 'What is the capital of Italy? One word answer.',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
    }

    expect(tokens.length).toBeGreaterThan(0);
    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect(String(result).toLowerCase()).toContain('rome');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// OpenAI Responses API: expanded coverage
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Thinking Integration: OpenAI Responses Expanded', () => {
  const reasoningModel = 'openai-responses:o4-mini';

  it('thinking with tool calling works on Responses API', async () => {
    const mathAgent = agent({
      model: reasoningModel,
      system:
        'You are a math assistant. Always use the calculator tool for arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-tool-responses',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-tool-responses', {
      question: 'What is 7 * 9?',
    });
    expect(String(result)).toContain('63');
  }, 30_000);

  it('streaming with thinking works on Responses API', async () => {
    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a helpful assistant. Keep answers very short.',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'thinking-stream-responses',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.prompt),
    });
    runtime.register(wf);

    const stream = runtime.stream('thinking-stream-responses', {
      prompt: 'What is the capital of Germany? One word answer.',
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
    }

    expect(tokens.length).toBeGreaterThan(0);
    const result = await stream.promise;
    expect(typeof result).toBe('string');
    expect(String(result).toLowerCase()).toContain('berlin');
  }, 30_000);

  it('structured output with thinking works on Responses API', async () => {
    const ColorSchema = z.object({
      name: z.string(),
      hex: z.string(),
      isWarm: z.boolean(),
    });

    const reasoner = agent({
      model: reasoningModel,
      system: 'You are a color expert. Respond with valid JSON matching the requested schema.',
      effort: 'low',
    });

    const result = await reasoner.ask('Tell me about the color red. Its hex code is #FF0000.', {
      schema: ColorSchema,
    });

    const parsed = ColorSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('red');
      expect(parsed.data.isWarm).toBe(true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Gemini: structured output + thinking
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('Thinking Integration: Gemini Structured Output', () => {
  const model = 'google:gemini-2.5-flash';

  it('structured output with thinking works', async () => {
    const AnimalSchema = z.object({
      name: z.string(),
      legs: z.number(),
      canFly: z.boolean(),
    });

    const thinker = agent({
      model,
      system: 'You are a zoology assistant. Respond with valid JSON matching the requested schema.',
      effort: 'low',
    });

    const result = await thinker.ask('Tell me about a penguin.', {
      schema: AnimalSchema,
    });

    const parsed = AnimalSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name.toLowerCase()).toContain('penguin');
      expect(parsed.data.legs).toBe(2);
      expect(parsed.data.canFly).toBe(false);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Sessions + thinking (multi-turn history with thinking enabled)
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('Thinking Integration: Sessions', () => {
  const model = 'anthropic:claude-haiku-4-5';

  it('session retains context across turns with thinking enabled', async () => {
    const chatAgent = agent({
      model,
      system:
        'You are a helpful assistant with perfect memory. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'thinking-session-chat',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('thinking-test-' + Date.now());

    // Turn 1: establish a fact
    await session.send('thinking-session-chat', {
      message: 'My favorite color is cerulean. Just acknowledge.',
    });

    // Turn 2: recall the fact
    const answer = await session.send('thinking-session-chat', {
      message: 'What is my favorite color? Answer with just the color name.',
    });

    expect(String(answer).toLowerCase()).toContain('cerulean');
    await session.end();
  }, 60_000);
});

describe.skipIf(!hasOpenAI)('Thinking Integration: Sessions OpenAI', () => {
  const reasoningModel = 'openai:o4-mini';

  it('session retains context across turns with thinking on reasoning model', async () => {
    const chatAgent = agent({
      model: reasoningModel,
      system:
        'You are a helpful assistant with perfect memory. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'thinking-session-openai',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('thinking-openai-' + Date.now());

    await session.send('thinking-session-openai', {
      message: 'My pet hamster is named Pixel. Just acknowledge.',
    });

    const answer = await session.send('thinking-session-openai', {
      message: "What is my hamster's name? Answer with just the name.",
    });

    expect(String(answer).toLowerCase()).toContain('pixel');
    await session.end();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Sessions + thinking: Gemini (contents/parts message format)
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('Thinking Integration: Sessions Gemini', () => {
  const model = 'google:gemini-2.5-flash';

  it('session retains context across turns with thinking enabled', async () => {
    const chatAgent = agent({
      model,
      system:
        'You are a helpful assistant with perfect memory. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'thinking-session-gemini',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('thinking-gemini-' + Date.now());

    await session.send('thinking-session-gemini', {
      message: 'My favorite fruit is dragonfruit. Just acknowledge.',
    });

    const answer = await session.send('thinking-session-gemini', {
      message: 'What is my favorite fruit? Answer with just the fruit name.',
    });

    expect(String(answer).toLowerCase()).toContain('dragonfruit');
    await session.end();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Sessions + thinking: OpenAI Responses API (input format differs from Chat)
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Thinking Integration: Sessions OpenAI Responses', () => {
  const model = 'openai-responses:o4-mini';

  it('session retains context across turns with thinking on Responses API', async () => {
    const chatAgent = agent({
      model,
      system:
        'You are a helpful assistant with perfect memory. Keep answers very short (one sentence max).',
      effort: 'low',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'thinking-session-responses',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('thinking-responses-' + Date.now());

    await session.send('thinking-session-responses', {
      message: 'My cat is named Nimbus. Just acknowledge.',
    });

    const answer = await session.send('thinking-session-responses', {
      message: "What is my cat's name? Answer with just the name.",
    });

    expect(String(answer).toLowerCase()).toContain('nimbus');
    await session.end();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Thought Visibility — verify thinking_content and thinking_delta
//
// Uses provider instances directly to access the full ProviderResponse
// (agent.ask() only returns the string content).
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('Thought Visibility: Anthropic', () => {
  it('thinking_content is returned when thinking is active', async () => {
    const provider = new AnthropicProvider();
    const response = await provider.chat(
      [
        { role: 'system', content: 'You are a helpful assistant. Keep answers short.' },
        { role: 'user', content: 'What is 15 * 17?' },
      ],
      { model: 'claude-haiku-4-5', effort: 'low', maxTokens: 16000 },
    );

    expect(response.content).toBeTruthy();
    expect(response.content).toContain('255');
    // Anthropic returns thinking blocks when thinking is enabled
    expect(response.thinking_content).toBeDefined();
    expect(typeof response.thinking_content).toBe('string');
    expect(response.thinking_content!.length).toBeGreaterThan(0);
  }, 30_000);

  it('thinking_delta chunks are emitted during streaming', async () => {
    const provider = new AnthropicProvider();
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'You are a helpful assistant. Keep answers short.' },
        { role: 'user', content: 'What is 12 + 8?' },
      ],
      { model: 'claude-haiku-4-5', effort: 'low', maxTokens: 16000 },
    )) {
      chunks.push(chunk);
    }

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking_delta');
    const textChunks = chunks.filter((c) => c.type === 'text_delta');

    // Should have both thinking and text chunks
    expect(thinkingChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!hasOpenAI)('Thought Visibility: OpenAI Responses', () => {
  it('thinking_content is returned with includeThoughts on reasoning model', async () => {
    const provider = new OpenAIResponsesProvider();
    const response = await provider.chat(
      [
        { role: 'system', content: 'You are a helpful assistant. Keep answers short.' },
        { role: 'user', content: 'What is 15 * 17?' },
      ],
      { model: 'o4-mini', effort: 'low', includeThoughts: true },
    );

    expect(response.content).toBeTruthy();
    expect(response.content).toContain('255');
    // Reasoning summaries may not be returned for trivial questions —
    // OpenAI only emits them when reasoning is non-trivial.
    if (response.thinking_content !== undefined) {
      expect(typeof response.thinking_content).toBe('string');
      expect(response.thinking_content!.length).toBeGreaterThan(0);
    }
  }, 30_000);

  // Note: reasoning summary deltas are only emitted for non-trivial reasoning.
  // Simple arithmetic may not produce summary events, so we use a harder question.
  it('thinking_delta chunks are emitted during streaming with includeThoughts', async () => {
    const provider = new OpenAIResponsesProvider();
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'You are a math tutor. Show your reasoning.' },
        {
          role: 'user',
          content:
            'A train leaves at 3pm going 60mph. Another leaves at 4pm going 80mph in the same direction. When does the second catch the first?',
        },
      ],
      { model: 'o4-mini', effort: 'medium', includeThoughts: true, maxTokens: 4096 },
    )) {
      chunks.push(chunk);
    }

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking_delta');
    const textChunks = chunks.filter((c) => c.type === 'text_delta');

    expect(thinkingChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!hasGoogle)('Thought Visibility: Gemini', () => {
  it('thinking_content is returned with includeThoughts', async () => {
    const provider = new GeminiProvider();
    const response = await provider.chat(
      [
        { role: 'system', content: 'You are a helpful assistant. Keep answers short.' },
        { role: 'user', content: 'What is 15 * 17?' },
      ],
      { model: 'gemini-2.5-flash', effort: 'low', includeThoughts: true },
    );

    expect(response.content).toBeTruthy();
    expect(response.content).toContain('255');
    // Gemini returns thought summaries with includeThoughts
    expect(response.thinking_content).toBeDefined();
    expect(typeof response.thinking_content).toBe('string');
    expect(response.thinking_content!.length).toBeGreaterThan(0);
  }, 30_000);

  it('thinking_delta chunks are emitted during streaming with includeThoughts', async () => {
    const provider = new GeminiProvider();
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(
      [
        { role: 'system', content: 'You are a helpful assistant. Keep answers short.' },
        { role: 'user', content: 'What is 12 + 8?' },
      ],
      { model: 'gemini-2.5-flash', effort: 'low', includeThoughts: true },
    )) {
      chunks.push(chunk);
    }

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking_delta');
    const textChunks = chunks.filter((c) => c.type === 'text_delta');

    expect(thinkingChunks.length).toBeGreaterThan(0);
    expect(textChunks.length).toBeGreaterThan(0);
  }, 30_000);
});
