import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent } from '../types.js';
import { TimeoutError, MaxTurnsError, QuorumNotMet, VerifyError } from '../errors.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

const providers = [
  ...(hasOpenAI ? [{ name: 'OpenAI', model: 'openai:gpt-4.1-nano' }] : []),
  ...(hasAnthropic ? [{ name: 'Anthropic', model: 'anthropic:claude-haiku-4-5' }] : []),
];

/** Generate one `it()` per available provider. */
function forEachProvider(
  label: string,
  fn: (model: string, providerName: string) => Promise<void>,
  timeout = 30_000,
) {
  for (const p of providers) {
    it(`${label} [${p.name}]`, () => fn(p.model, p.name), timeout);
  }
}

// ---------------------------------------------------------------------------
// Shared tools
// ---------------------------------------------------------------------------

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

const failingTool = tool({
  name: 'failing_tool',
  description: 'A tool that always fails. Used for testing error recovery.',
  input: z.object({}),
  handler: () => {
    throw new Error('This tool intentionally fails');
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(providers.length === 0)('Advanced Integration', () => {
  // ── 1. Multi-step research pipeline ─────────────────────────────────

  forEachProvider(
    'multi-step research pipeline with tool calls and structured summary',
    async (model) => {
      const SummarySchema = z.object({
        step1_result: z.number(),
        step2_result: z.number(),
        final_answer: z.number(),
      });

      const researchAgent = agent({
        model,
        system:
          'You are a math research assistant. Use the calculator tool for EVERY arithmetic operation — never compute in your head. First calculate 15 + 27, then calculate 6 * 7, then sum both results using the calculator. Finally, respond with ONLY a JSON object (no other text) with keys step1_result, step2_result, and final_answer.',
        tools: [calculatorTool],
      });

      const runtime = new AxlRuntime();
      const traces: AxlEvent[] = [];
      runtime.on('trace', (e: AxlEvent) => traces.push(e));

      const w = workflow({
        name: 'research-pipeline',
        input: z.object({ task: z.string() }),
        output: SummarySchema,
        handler: async (ctx) => ctx.ask(researchAgent, ctx.input.task, { schema: SummarySchema }),
      });

      runtime.register(w);
      const result = await runtime.execute('research-pipeline', {
        task: 'Calculate 15+27 and 6*7, then sum both results. Use the calculator for each step. Return JSON with step1_result, step2_result, and final_answer.',
      });

      const parsed = SummarySchema.safeParse(result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.step1_result).toBe(42);
        expect(parsed.data.step2_result).toBe(42);
        expect(parsed.data.final_answer).toBe(84);
      }

      // Should have made at least 2 calculator calls
      const toolCalls = traces.filter(
        (t): t is Extract<AxlEvent, { type: 'tool_call_end' }> =>
          t.type === 'tool_call_end' && t.tool === 'calculator',
      );
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    },
  );

  // ── 2. Self-correcting extraction ───────────────────────────────────

  forEachProvider('self-correcting extraction with enum + regex constraints', async (model) => {
    const StrictSchema = z.object({
      color: z.enum(['red', 'green', 'blue']),
      hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      rgb: z.object({
        r: z.number().min(0).max(255),
        g: z.number().min(0).max(255),
        b: z.number().min(0).max(255),
      }),
    });

    const colorAgent = agent({
      model,
      system:
        'You are a color data assistant. Always respond with valid JSON. The color MUST be exactly one of: "red", "green", "blue". The hex must be a 6-digit hex code starting with #. RGB values must be 0-255.',
    });

    const result = await colorAgent.ask(
      'Give me the color data for green. color must be "green", hex must be "#00FF00", and rgb must be {r:0, g:255, b:0}.',
      { schema: StrictSchema, retries: 3 },
    );

    const parsed = StrictSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.color).toBe('green');
      expect(parsed.data.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(parsed.data.rgb.g).toBe(255);
    }
  });

  // ── 3. Structured output without tools ──────────────────────────────

  forEachProvider('structured output without tools (pure JSON mode)', async (model) => {
    const BookSchema = z.object({
      title: z.string(),
      author: z.string(),
      year: z.number(),
      genre: z.enum(['fiction', 'non-fiction', 'science', 'history']),
    });

    const extractAgent = agent({
      model,
      system:
        'You are a book data extractor. Extract structured information about books. Always respond with valid JSON matching the requested schema.',
    });

    const result = await extractAgent.ask(
      'Extract info about "A Brief History of Time" by Stephen Hawking, published in 1988. It is a science book.',
      { schema: BookSchema },
    );

    const parsed = BookSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title.toLowerCase()).toContain('brief history');
      expect(parsed.data.author.toLowerCase()).toContain('hawking');
      expect(parsed.data.year).toBe(1988);
      expect(parsed.data.genre).toBe('science');
    }
  });

  // ── 4. Expert panel with majority vote ──────────────────────────────

  forEachProvider(
    'spawn 3 agents and majority vote on structured result',
    async (model) => {
      const AnswerSchema = z.object({
        element: z.string(),
        symbol: z.string(),
        atomic_number: z.number(),
      });

      const scienceAgent = agent({
        model,
        system:
          'You are a chemistry expert. Always respond with valid JSON matching the requested schema.',
      });

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'expert-panel',
        input: z.object({ question: z.string() }),
        handler: async (ctx) => {
          const results = await ctx.spawn(3, async () => {
            return ctx.ask(scienceAgent, ctx.input.question, { schema: AnswerSchema });
          });

          return ctx.vote(results, { strategy: 'majority', key: 'atomic_number' });
        },
      });

      runtime.register(w);
      const result = (await runtime.execute('expert-panel', {
        question:
          'What is the atomic number of Oxygen? Element is "Oxygen", symbol is "O". Respond with JSON: {"element": "Oxygen", "symbol": "O", "atomic_number": 8}',
      })) as { element: string; symbol: string; atomic_number: number };

      expect(result.atomic_number).toBe(8);
      expect(result.symbol.toUpperCase()).toBe('O');
    },
    60_000,
  );

  // ── 5. First-responder race ─────────────────────────────────────────

  forEachProvider('race two agents with schema validation, first valid wins', async (model) => {
    const CapitalSchema = z.object({
      capital: z.string(),
      country: z.string(),
      continent: z.string(),
    });

    const geoAgent = agent({
      model,
      system:
        'You are a geography assistant. Respond with valid JSON matching the requested schema.',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'race-schema',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => {
        return ctx.race(
          [
            () => ctx.ask(geoAgent, ctx.input.question, { schema: CapitalSchema }),
            () => ctx.ask(geoAgent, ctx.input.question, { schema: CapitalSchema }),
          ],
          { schema: CapitalSchema },
        );
      },
    });

    runtime.register(w);
    const result = (await runtime.execute('race-schema', {
      question:
        'What is the capital of Japan? Respond with JSON including capital, country, and continent.',
    })) as { capital: string; country: string; continent: string };

    const parsed = CapitalSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capital.toLowerCase()).toContain('tokyo');
      expect(parsed.data.country.toLowerCase()).toContain('japan');
    }
  });

  // ── 6. Batch classification with bounded concurrency ────────────────

  forEachProvider(
    'map classifies items with concurrency:2 and structured output',
    async (model) => {
      const CategorySchema = z.object({
        item: z.string(),
        category: z.enum(['fruit', 'vegetable', 'grain', 'protein']),
      });

      const classifier = agent({
        model,
        system:
          'You are a food classifier. Classify the given food item into exactly one category: "fruit", "vegetable", "grain", or "protein". Respond with valid JSON matching the requested schema.',
      });

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'batch-classify',
        input: z.object({ items: z.array(z.string()) }),
        handler: async (ctx) => {
          return ctx.map(
            ctx.input.items,
            async (item) =>
              ctx.ask(classifier, `Classify this food: ${item}`, { schema: CategorySchema }),
            { concurrency: 2 },
          );
        },
      });

      runtime.register(w);
      const results = (await runtime.execute('batch-classify', {
        items: ['apple', 'carrot', 'rice', 'chicken'],
      })) as Array<{ ok: boolean; value?: { item: string; category: string } }>;

      expect(results).toHaveLength(4);
      const successes = results.filter((r) => r.ok);
      expect(successes.length).toBeGreaterThanOrEqual(3);

      for (const r of successes) {
        const val = r.value!;
        const item = val.item.toLowerCase();
        if (item.includes('apple')) expect(val.category).toBe('fruit');
        if (item.includes('carrot')) expect(val.category).toBe('vegetable');
        if (item.includes('rice')) expect(val.category).toBe('grain');
        if (item.includes('chicken')) expect(val.category).toBe('protein');
      }
    },
    60_000,
  );

  // ── 7. Parallel independent queries ─────────────────────────────────

  forEachProvider('parallel asks two different questions simultaneously', async (model) => {
    const factAgent = agent({
      model,
      system: 'You are a factual assistant. Keep answers to one short sentence.',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'parallel-queries',
      input: z.object({}),
      handler: async (ctx) => {
        const [capital, element] = await ctx.parallel([
          () =>
            ctx.ask(factAgent, 'What is the capital of Australia? Answer with just the city name.'),
          () =>
            ctx.ask(
              factAgent,
              'What is the chemical symbol for gold? Answer with just the symbol.',
            ),
        ]);
        return { capital, element };
      },
    });

    runtime.register(w);
    const result = (await runtime.execute('parallel-queries', {})) as {
      capital: string;
      element: string;
    };

    expect(String(result.capital).toLowerCase()).toContain('canberra');
    expect(String(result.element)).toContain('Au');
  });

  // ── 8. Customer support handoff ─────────────────────────────────────

  forEachProvider('handoff from triage agent to specialist who uses tools', async (model) => {
    const mathExpert = agent({
      name: 'math_expert',
      model,
      system:
        'You are a math expert. Use the calculator tool for all arithmetic. Return only the final numeric answer.',
      tools: [calculatorTool],
    });

    const triageAgent = agent({
      name: 'triage',
      model,
      system:
        'You are a triage agent. For ANY math question, immediately hand off to the math_expert agent. Do not attempt to answer math questions yourself.',
      handoffs: [{ agent: mathExpert }],
    });

    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => traces.push(e));

    const w = workflow({
      name: 'support-handoff',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(triageAgent, ctx.input.question),
    });

    runtime.register(w);
    const result = await runtime.execute('support-handoff', {
      question: 'What is 13 * 17?',
    });

    // Verify handoff_start trace was emitted (always fires with target/mode).
    const handoffs = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'handoff_start' }> => t.type === 'handoff_start',
    );
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    expect(handoffs[0].data.target).toBe('math_expert');

    // Calculator should have been used by the math expert
    const toolCalls = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'tool_call_end' }> =>
        t.type === 'tool_call_end' && t.tool === 'calculator',
    );
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    expect(String(result)).toContain('221');
  });

  // ── 9. Dynamic expert routing ───────────────────────────────────────

  forEachProvider('dynamic model + system function selection via metadata', async (model) => {
    const dynamicAgent = agent({
      name: 'dynamic-expert',
      model: (ctx) => {
        // In test, both map to same model — validates the function is called
        const domain = ctx.metadata?.domain;
        if (domain === 'science') return model;
        return model;
      },
      system: (ctx) => {
        const domain = ctx.metadata?.domain;
        if (domain === 'science') return 'You are a science expert. Keep answers to one sentence.';
        return 'You are a general assistant. Keep answers to one sentence.';
      },
    });

    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => traces.push(e));

    const w = workflow({
      name: 'dynamic-routing',
      input: z.object({ prompt: z.string(), domain: z.string() }),
      handler: async (ctx) => {
        return ctx.ask(dynamicAgent, ctx.input.prompt, {
          metadata: { domain: ctx.input.domain },
        });
      },
    });

    runtime.register(w);
    const result = await runtime.execute('dynamic-routing', {
      prompt: 'What is the boiling point of water in Celsius?',
      domain: 'science',
    });

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('100');

    // Verify the trace recorded the model URI
    const agentCalls = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'agent_call_end' }> => t.type === 'agent_call_end',
    );
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(agentCalls[0].model).toBe(model);
  });

  // ── 10. Multi-turn session with recall ──────────────────────────────

  forEachProvider('session retains context and recalls facts across turns', async (model) => {
    const chatAgent = agent({
      model,
      system:
        'You are a helpful assistant with perfect memory. Keep answers very short (one sentence max).',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'session-chat',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('recall-test-' + Date.now());

    // Turn 1: establish a fact
    await session.send('session-chat', {
      message: 'My pet parrot is named Zephyr. Just acknowledge.',
    });

    // Turn 2: recall the fact
    const answer = await session.send('session-chat', {
      message: "What is my parrot's name? Answer with just the name.",
    });

    expect(String(answer).toLowerCase()).toContain('zephyr');
    await session.end();
  });

  // ── 11. Session fork with divergent histories ───────────────────────

  forEachProvider(
    'forked sessions diverge independently',
    async (model) => {
      const chatAgent = agent({
        model,
        system: 'You are a helpful assistant. Keep answers very short.',
      });

      const runtime = new AxlRuntime();
      const chatWorkflow = workflow({
        name: 'fork-chat',
        input: z.object({ message: z.string() }),
        handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
      });

      runtime.register(chatWorkflow);
      const baseId = 'fork-test-' + Date.now();
      const sessionA = runtime.session(baseId);

      // Establish shared context
      await sessionA.send('fork-chat', {
        message: 'My favorite fruit is MANGO. Just acknowledge.',
      });

      // Fork into two branches
      const sessionB = await sessionA.fork(baseId + '-branch');

      // Diverge: tell branch B a different fruit
      await sessionB.send('fork-chat', {
        message: 'Actually, I changed my mind. My favorite fruit is now KIWI. Acknowledge.',
      });

      // Ask each session for the fruit
      const answerA = await sessionA.send('fork-chat', {
        message: 'What is my favorite fruit? Reply with just the fruit name.',
      });
      const answerB = await sessionB.send('fork-chat', {
        message: 'What is my favorite fruit? Reply with just the fruit name.',
      });

      expect(String(answerA).toUpperCase()).toContain('MANGO');
      expect(String(answerB).toUpperCase()).toContain('KIWI');

      // Verify histories have different lengths
      const histA = await sessionA.history();
      const histB = await sessionB.history();
      expect(histB.length).toBeGreaterThan(histA.length);

      await sessionA.end();
      await sessionB.end();
    },
    60_000,
  );

  // ── 12. Budget-constrained multi-call ───────────────────────────────

  forEachProvider('budget tracks cumulative cost across multiple calls', async (model) => {
    const cheapAgent = agent({
      model,
      system: 'You are a helpful assistant. Keep answers to one word.',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'budget-track',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.budget({ cost: '$1.00', onExceed: 'warn' }, async () => {
          await ctx.ask(cheapAgent, 'Say hello.');
          await ctx.ask(cheapAgent, 'Say world.');
          await ctx.ask(cheapAgent, 'Say goodbye.');
          return 'done';
        });
      },
    });

    runtime.register(w);
    const result = (await runtime.execute('budget-track', {})) as {
      value: string;
      budgetExceeded: boolean;
      totalCost: number;
    };

    expect(result.value).toBe('done');
    expect(result.budgetExceeded).toBe(false);
    // Cost should be >= 0 (real API calls cost something, but some providers don't report)
    expect(result.totalCost).toBeGreaterThanOrEqual(0);
  });

  // ── 13. Streaming tool pipeline ─────────────────────────────────────

  forEachProvider(
    'streaming emits interleaved token and tool_call events',
    async (model) => {
      const mathAgent = agent({
        model,
        system:
          'You are a math assistant. Use the calculator tool for arithmetic. After getting the result, write a short sentence with the answer.',
        tools: [calculatorTool],
      });

      const runtime = new AxlRuntime();
      const streamWorkflow = workflow({
        name: 'stream-tools',
        input: z.object({ question: z.string() }),
        handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
      });

      runtime.register(streamWorkflow);

      const stream = runtime.stream('stream-tools', {
        question: 'What is 19 + 23? Use the calculator.',
      });

      const tokens: string[] = [];
      const toolCallEvents: Array<Extract<AxlEvent, { type: 'tool_call_end' }>> = [];
      for await (const event of stream) {
        if (event.type === 'token') tokens.push(event.data);
        if (event.type === 'tool_call_end') toolCallEvents.push(event);
      }

      // Should have received tokens (the final text response)
      expect(tokens.length).toBeGreaterThan(0);

      // Should have received at least one tool_call_end event for calculator.
      // Post-spec/16: tool name lives on `event.tool`, not `event.name`.
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
      expect(toolCallEvents[0].tool).toBe('calculator');

      // The final result should contain 42
      const result = await stream.promise;
      expect(String(result)).toContain('42');
    },
    60_000,
  );

  // ── 14. Map → Vote pipeline ─────────────────────────────────────────

  forEachProvider(
    'map items through classifier then vote on majority result',
    async (model) => {
      const CategorySchema = z.object({
        item: z.string(),
        type: z.enum(['mammal', 'reptile', 'bird', 'fish']),
      });

      const animalClassifier = agent({
        model,
        system:
          'You are an animal classifier. Classify the given animal into exactly one type: "mammal", "reptile", "bird", or "fish". Respond with valid JSON matching the requested schema.',
      });

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'map-vote-pipeline',
        input: z.object({ animals: z.array(z.string()) }),
        handler: async (ctx) => {
          // Map: classify each animal
          const classified = await ctx.map(
            ctx.input.animals,
            async (animal) =>
              ctx.ask(animalClassifier, `Classify this animal: ${animal}`, {
                schema: CategorySchema,
              }),
            { concurrency: 3 },
          );

          // Vote: find the most common category
          const winner = ctx.vote(classified, { strategy: 'majority', key: 'type' });
          return winner;
        },
      });

      runtime.register(w);
      // 3 mammals, so majority should be "mammal"
      const result = (await runtime.execute('map-vote-pipeline', {
        animals: ['dog', 'cat', 'eagle', 'whale'],
      })) as { item: string; type: string };

      expect(result.type).toBe('mammal');
    },
    60_000,
  );

  // ── 15. Spawn + structured output + tool use ────────────────────────

  forEachProvider(
    'spawn agents that use tools and return structured output, then vote highest',
    async (model) => {
      const ScoreSchema = z.object({
        expression: z.string(),
        result: z.number(),
      });

      const calcAgent = agent({
        model,
        system:
          'You are a math assistant. Use the calculator tool to evaluate the given expression. Then return JSON with "expression" (the original expression) and "result" (the numeric answer).',
        tools: [calculatorTool],
      });

      const runtime = new AxlRuntime();
      const traces: AxlEvent[] = [];
      runtime.on('trace', (e: AxlEvent) => traces.push(e));

      const w = workflow({
        name: 'spawn-tool-vote',
        input: z.object({ expressions: z.array(z.string()) }),
        handler: async (ctx) => {
          const results = await ctx.spawn(ctx.input.expressions.length, async (i) => {
            return ctx.ask(
              calcAgent,
              `Evaluate: ${ctx.input.expressions[i]}. Use the calculator.`,
              { schema: ScoreSchema },
            );
          });

          // Pick the expression with the highest result
          return ctx.vote(results, { strategy: 'highest', key: 'result' });
        },
      });

      runtime.register(w);
      const result = (await runtime.execute('spawn-tool-vote', {
        expressions: ['3 + 4', '10 * 5'],
      })) as { expression: string; result: number };

      // 10 * 5 = 50 should be higher than 3 + 4 = 7
      expect(result.result).toBe(50);

      // Multiple calculator tool calls should have been made (one per agent)
      const toolCalls = traces.filter(
        (t): t is Extract<AxlEvent, { type: 'tool_call_end' }> =>
          t.type === 'tool_call_end' && t.tool === 'calculator',
      );
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    },
    60_000,
  );

  // ── Group 6: Error Paths & Safety ─────────────────────────────────

  // ── 17. Budget hard_stop cancels subsequent operations ─────────────

  forEachProvider('budget hard_stop cancels subsequent operations', async (model) => {
    const cheapAgent = agent({
      model,
      system: 'You are a helpful assistant. Keep answers to one word.',
    });

    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => traces.push(e));

    const w = workflow({
      name: 'budget-hard-stop',
      input: z.object({}),
      handler: async (ctx) => {
        let completedCalls = 0;
        return ctx.budget({ cost: '$0.0001', onExceed: 'hard_stop' }, async () => {
          // 10 sequential calls — budget will trip mid-sequence if provider reports cost
          for (let i = 0; i < 10; i++) {
            await ctx.ask(cheapAgent, `Say word number ${i + 1}.`);
            completedCalls++;
          }
          return completedCalls;
        });
      },
    });

    runtime.register(w);
    const result = (await runtime.execute('budget-hard-stop', {})) as {
      value: number | null;
      budgetExceeded: boolean;
      totalCost: number;
    };

    if (result.budgetExceeded) {
      // Budget tripped — value should be null (BudgetExceededError was caught)
      // and fewer than 10 agent_call traces should exist
      expect(result.value).toBeNull();
      expect(result.totalCost).toBeGreaterThan(0);
      const agentCalls = traces.filter(
        (t): t is Extract<AxlEvent, { type: 'agent_call_end' }> => t.type === 'agent_call_end',
      );
      expect(agentCalls.length).toBeLessThan(10);
    } else {
      // Provider didn't report cost — all 10 calls completed normally
      expect(result.value).toBe(10);
    }
  });

  // ── 18. Agent timeout on multi-turn tool loop ──────────────────────

  forEachProvider('agent timeout on multi-turn tool loop', async (model) => {
    const slowAgent = agent({
      model,
      system:
        'You are a math assistant. ALWAYS use the calculator tool for every question. Never answer without using the tool first.',
      tools: [calculatorTool],
      timeout: '100ms',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'timeout-test',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(slowAgent, ctx.input.question),
    });

    runtime.register(w);
    await expect(
      runtime.execute('timeout-test', { question: 'What is 2+2? Use the calculator.' }),
    ).rejects.toThrow(TimeoutError);
  });

  // ── 19. MaxTurns exceeded when agent needs more turns ──────────────

  forEachProvider('maxTurns exceeded when agent needs more turns', async (model) => {
    const limitedAgent = agent({
      model,
      system:
        'You are a math assistant. You MUST use the calculator tool to compute the answer. Never answer without using the calculator first.',
      tools: [calculatorTool],
      maxTurns: 1,
    });

    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => traces.push(e));

    const w = workflow({
      name: 'max-turns-test',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(limitedAgent, ctx.input.question),
    });

    runtime.register(w);
    let caughtError: unknown = null;
    try {
      await runtime.execute('max-turns-test', {
        question: 'What is 99 + 1? Use the calculator tool.',
      });
    } catch (err) {
      caughtError = err;
    }

    const toolCalls = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'tool_call_end' }> => t.type === 'tool_call_end',
    );
    if (toolCalls.length > 0) {
      // Agent used a tool → with maxTurns:1 the loop exits → MaxTurnsError required
      expect(caughtError).toBeInstanceOf(MaxTurnsError);
      expect((caughtError as MaxTurnsError).maxTurns).toBe(1);
      expect((caughtError as MaxTurnsError).code).toBe('MAX_TURNS');
    } else {
      // Agent answered directly without tools — no error, but this is rare
      expect(caughtError).toBeNull();
    }
  });

  // ── Group 7: Untested Primitives ──────────────────────────────────

  // ── 20. ctx.verify() with schema retry and fallback ────────────────

  forEachProvider(
    'ctx.verify() with schema retry and fallback',
    async (model) => {
      const extractAgent = agent({
        model,
        system: 'You are a data extraction assistant. Respond with ONLY valid JSON, no other text.',
      });

      const StrictSchema = z.object({
        name: z.string(),
        age: z.number().int().min(0).max(150),
      });
      const fallbackValue = { name: 'Unknown', age: 0 };

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'verify-test',
        input: z.object({ prompt: z.string() }),
        handler: async (ctx) => {
          return ctx.verify(
            async (retry) => {
              let msg = ctx.input.prompt;
              if (retry) {
                msg += `\n\nYour previous response was invalid: ${JSON.stringify(retry.output)}\nError: ${retry.error}\nPlease fix and try again.`;
              }
              const raw = await ctx.ask(extractAgent, msg);
              return JSON.parse(raw as string);
            },
            StrictSchema,
            { retries: 2, fallback: fallbackValue },
          );
        },
      });

      runtime.register(w);
      const result = await runtime.execute('verify-test', {
        prompt:
          'Extract: John Doe is 30 years old. Respond with JSON: {"name": "John Doe", "age": 30}',
      });

      const parsed = StrictSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    },
    60_000,
  );

  // ── 21. session.stream() emits tokens and updates history ──────────

  forEachProvider('session.stream() emits tokens and updates history', async (model) => {
    const chatAgent = agent({
      model,
      system: 'You are a helpful assistant. Keep answers to one sentence.',
    });

    const runtime = new AxlRuntime();
    const chatWorkflow = workflow({
      name: 'stream-session-chat',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
    });

    runtime.register(chatWorkflow);
    const session = runtime.session('stream-test-' + Date.now());

    const stream = await session.stream('stream-session-chat', { message: 'What is 2 + 2?' });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
    }

    // Wait for the stream promise to resolve
    await stream.promise;
    // Small delay to let async history update complete
    await new Promise((r) => setTimeout(r, 200));

    expect(tokens.length).toBeGreaterThan(0);

    const hist = await session.history();
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist.some((m) => m.role === 'user')).toBe(true);
    expect(hist.some((m) => m.role === 'assistant')).toBe(true);

    await session.end();
  });

  // ── 22. Context window summarization preserves key facts ───────────

  forEachProvider(
    'context window summarization preserves key facts',
    async (model) => {
      const chatAgent = agent({
        model,
        system: 'You are a helpful assistant with perfect memory. Keep answers short.',
        maxContext: 500,
      });

      const runtime = new AxlRuntime({ contextManagement: { reserveTokens: 100 } });
      const chatWorkflow = workflow({
        name: 'context-window-chat',
        input: z.object({ message: z.string() }),
        handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
      });

      runtime.register(chatWorkflow);
      const session = runtime.session('ctx-window-test-' + Date.now());

      // Turn 1: establish a unique fact
      await session.send('context-window-chat', {
        message: 'My favorite made-up word is FLAMINGO-42. Please remember it. Just acknowledge.',
      });

      // Turns 2-3: pad history with long messages to trigger summarization
      const padding = 'x'.repeat(500);
      await session.send('context-window-chat', {
        message: `Here is some filler text to build up context: ${padding}. Just acknowledge.`,
      });
      await session.send('context-window-chat', {
        message: `More filler text: ${padding}. Just acknowledge.`,
      });

      // Turn 4: this should trigger summarization, ask for the fact
      const answer = await session.send('context-window-chat', {
        message: 'What was my favorite made-up word? Reply with just the word.',
      });

      expect(String(answer).toUpperCase()).toContain('FLAMINGO');

      await session.end();
    },
    60_000,
  );

  // ── Group 8: Edge Cases ───────────────────────────────────────────

  // ── 23. Tool error recovery — agent handles tool failure gracefully ─

  forEachProvider('tool error recovery — agent handles tool failure gracefully', async (model) => {
    const recoveryAgent = agent({
      model,
      system:
        'You are a math assistant. You have two tools: failing_tool and calculator. If a tool fails, try a different tool. Use the calculator to compute 7+8.',
      tools: [failingTool, calculatorTool],
    });

    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => traces.push(e));

    const w = workflow({
      name: 'tool-recovery',
      input: z.object({ task: z.string() }),
      handler: async (ctx) => ctx.ask(recoveryAgent, ctx.input.task),
    });

    runtime.register(w);
    const result = await runtime.execute('tool-recovery', {
      task: 'First try the failing_tool (it will error), then use the calculator to compute 7 + 8.',
    });

    expect(String(result)).toContain('15');
    const toolCalls = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'tool_call_end' }> => t.type === 'tool_call_end',
    );
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    const toolNames = toolCalls.map((t) => t.tool);
    expect(toolNames).toContain('failing_tool');
    expect(toolNames).toContain('calculator');
  });

  // ── 24. Multi-level handoff (A→B→C) ───────────────────────────────

  forEachProvider(
    'multi-level handoff (A→B→C)',
    async (model) => {
      const calculatorAgent = agent({
        name: 'calculator_agent',
        model,
        system:
          'You are a calculator agent. Use the calculator tool to compute the answer. Return only the numeric result.',
        tools: [calculatorTool],
      });

      const specialist = agent({
        name: 'specialist',
        model,
        system:
          'You are a specialist. For any math computation, immediately hand off to calculator_agent. Do not try to compute yourself.',
        handoffs: [{ agent: calculatorAgent }],
      });

      const router = agent({
        name: 'router',
        model,
        system:
          'You are a router. For any question, immediately hand off to the specialist. Do not answer yourself.',
        handoffs: [{ agent: specialist }],
      });

      const runtime = new AxlRuntime();
      const traces: AxlEvent[] = [];
      runtime.on('trace', (e: AxlEvent) => traces.push(e));

      const w = workflow({
        name: 'multi-handoff',
        input: z.object({ question: z.string() }),
        handler: async (ctx) => ctx.ask(router, ctx.input.question),
      });

      runtime.register(w);
      const result = await runtime.execute('multi-handoff', {
        question: 'What is 11 * 13?',
      });

      // Two handoff_start events expected: router → specialist, then
      // specialist → calculator_agent. Both are always emitted regardless
      // of mode.
      const handoffs = traces.filter(
        (t): t is Extract<AxlEvent, { type: 'handoff_start' }> => t.type === 'handoff_start',
      );
      expect(handoffs.length).toBeGreaterThanOrEqual(2);

      const targets = handoffs.map((h) => h.data.target);
      expect(targets).toContain('specialist');
      expect(targets).toContain('calculator_agent');

      expect(String(result)).toContain('143');
    },
    60_000,
  );

  // ── 25. Race rejects when all branches fail schema validation ──────

  forEachProvider('race rejects when all branches fail schema validation', async (model) => {
    const ImpossibleSchema = z.literal('impossible_value_xyz');

    const factAgent = agent({
      model,
      system: 'You are a helpful assistant. Answer questions concisely.',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'race-schema-fail',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.race(
          [
            () => ctx.ask(factAgent, 'What is the capital of France?'),
            () => ctx.ask(factAgent, 'What is the capital of Germany?'),
          ],
          { schema: ImpossibleSchema },
        );
      },
    });

    runtime.register(w);
    await expect(runtime.execute('race-schema-fail', {})).rejects.toThrow(
      /Schema validation failed/,
    );
  });

  // ── 26. Map with impossible quorum throws QuorumNotMet ─────────────

  forEachProvider(
    'map with impossible quorum throws QuorumNotMet',
    async (model) => {
      const classifier = agent({
        model,
        system: 'You are a classifier. Respond with a single word category.',
      });

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'map-quorum-fail',
        input: z.object({ items: z.array(z.string()) }),
        handler: async (ctx) => {
          return ctx.map(
            ctx.input.items,
            async (item) => ctx.ask(classifier, `Classify: ${item}`),
            { quorum: 4 },
          );
        },
      });

      runtime.register(w);
      try {
        await runtime.execute('map-quorum-fail', { items: ['apple', 'dog', 'car'] });
        // Should not reach here
        expect.unreachable('Expected QuorumNotMet to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QuorumNotMet);
        expect((err as QuorumNotMet).code).toBe('QUORUM_NOT_MET');
        expect((err as QuorumNotMet).message).toMatch(/needed 4 successes, got 3/);
        expect((err as QuorumNotMet).results).toHaveLength(3);
      }
    },
    60_000,
  );

  // ── Group 9: Error Class Assertions ───────────────────────────────

  // ── 27. VerifyError thrown after retries exhausted ──────────────────

  forEachProvider(
    'VerifyError thrown when schema validation fails after all retries',
    async (model) => {
      // Use ctx.verify() — unlike ctx.ask(schema), it does NOT leak the schema
      // into the prompt, so the LLM cannot reverse-engineer the required value.
      const StrictSchema = z.object({
        impossible: z.number().min(999999).max(999999),
      });

      const chatAgent = agent({
        model,
        system: 'You are a helpful assistant. Keep answers to one sentence.',
      });

      const runtime = new AxlRuntime();
      const w = workflow({
        name: 'verify-error-test',
        input: z.object({}),
        handler: async (ctx) => {
          return ctx.verify(
            async () => {
              // Returns a plain string — can never satisfy z.object(...)
              return ctx.ask(chatAgent, 'Say hello.');
            },
            StrictSchema,
            { retries: 1 },
          );
        },
      });

      runtime.register(w);
      try {
        await runtime.execute('verify-error-test', {});
        expect.unreachable('Expected VerifyError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyError);
        expect((err as VerifyError).code).toBe('VERIFY_ERROR');
        expect((err as VerifyError).retries).toBe(1);
        expect((err as VerifyError).lastOutput).toBeDefined();
        expect((err as VerifyError).zodError).toBeDefined();
      }
    },
    60_000,
  );

  // ── 28. BudgetExceededError thrown with finish_and_stop policy ──────

  forEachProvider('BudgetExceededError thrown with finish_and_stop policy', async (model) => {
    const cheapAgent = agent({
      model,
      system: 'You are a helpful assistant. Keep answers to one word.',
    });

    const runtime = new AxlRuntime();
    const w = workflow({
      name: 'budget-finish-stop',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.budget({ cost: '$0.0001', onExceed: 'finish_and_stop' }, async () => {
          // 10 sequential calls — budget will trip mid-sequence if provider reports cost
          for (let i = 0; i < 10; i++) {
            await ctx.ask(cheapAgent, `Say word number ${i + 1}.`);
          }
          return 'all-done';
        });
      },
    });

    runtime.register(w);
    const result = (await runtime.execute('budget-finish-stop', {})) as {
      value: string | null;
      budgetExceeded: boolean;
      totalCost: number;
    };

    if (result.budgetExceeded) {
      // finish_and_stop: BudgetExceededError was thrown and caught by budget() wrapper
      expect(result.value).toBeNull();
      expect(result.totalCost).toBeGreaterThan(0);
    } else {
      // Provider didn't report cost — all calls completed normally
      expect(result.value).toBe('all-done');
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-provider agreement (requires both keys)
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI || !hasAnthropic)('Cross-provider agreement', () => {
  it('both providers extract identical structured data for a factual query', async () => {
    const PlanetSchema = z.object({
      name: z.string(),
      position: z.number(),
      has_rings: z.boolean(),
    });

    const openaiExtractor = agent({
      model: 'openai:gpt-4.1-nano',
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema. Be precise and factual.',
    });

    const anthropicExtractor = agent({
      model: 'anthropic:claude-haiku-4-5',
      system:
        'You are a data extraction assistant. Always respond with valid JSON matching the requested schema. Be precise and factual.',
    });

    const prompt =
      'Extract data about Saturn: its name, its position from the sun (as a number), and whether it has rings (boolean).';

    const [openaiResult, anthropicResult] = await Promise.all([
      openaiExtractor.ask(prompt, { schema: PlanetSchema }),
      anthropicExtractor.ask(prompt, { schema: PlanetSchema }),
    ]);

    const openaiParsed = PlanetSchema.safeParse(openaiResult);
    const anthropicParsed = PlanetSchema.safeParse(anthropicResult);

    expect(openaiParsed.success).toBe(true);
    expect(anthropicParsed.success).toBe(true);

    if (openaiParsed.success && anthropicParsed.success) {
      // Both should agree on factual content
      expect(openaiParsed.data.name.toLowerCase()).toContain('saturn');
      expect(anthropicParsed.data.name.toLowerCase()).toContain('saturn');
      expect(openaiParsed.data.position).toBe(6);
      expect(anthropicParsed.data.position).toBe(6);
      expect(openaiParsed.data.has_rings).toBe(true);
      expect(anthropicParsed.data.has_rings).toBe(true);
    }
  }, 30_000);
});
