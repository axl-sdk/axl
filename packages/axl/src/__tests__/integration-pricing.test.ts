import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { StreamChunk } from '../providers/types.js';
import type { ChatMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
const hasGoogle = !!process.env.GOOGLE_API_KEY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function getDone(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'done' }> | undefined {
  return chunks.find((c): c is Extract<StreamChunk, { type: 'done' }> => c.type === 'done');
}

/**
 * System prompt long enough to exceed the 1024-token minimum for automatic
 * prompt caching on OpenAI and Anthropic (~1500 tokens, ~6 KB).
 */
const CACHE_ELIGIBLE_SYSTEM =
  'You are a helpful assistant. ' +
  (
    'The following is important context that you should keep in mind when answering. ' +
    'Always respond accurately and concisely. '
  ).repeat(70);

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Pricing Integration: OpenAI Chat Completions', () => {
  let provider: OpenAIProvider;
  const model = 'gpt-4.1-nano';
  const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly one word: Hello' }];
  const opts = { model, maxTokens: 10 };

  beforeAll(() => {
    provider = new OpenAIProvider();
  });

  it('chat() returns a positive cost and well-shaped usage', async () => {
    const response = await provider.chat(messages, opts);

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
    // cached_tokens, if present, must be non-negative and ≤ prompt_tokens
    if (response.usage!.cached_tokens != null) {
      expect(response.usage!.cached_tokens).toBeGreaterThanOrEqual(0);
      expect(response.usage!.cached_tokens).toBeLessThanOrEqual(response.usage!.prompt_tokens);
    }
  }, 30_000);

  it('stream() done chunk contains cost and well-shaped usage', async () => {
    const chunks = await collectChunks(provider.stream(messages, opts));
    const done = getDone(chunks);

    expect(done).toBeDefined();
    expect(done!.cost).toBeTypeOf('number');
    expect(done!.cost).toBeGreaterThan(0);

    expect(done!.usage).toBeDefined();
    expect(done!.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done!.usage!.completion_tokens).toBeGreaterThan(0);
    expect(done!.usage!.total_tokens).toBe(
      done!.usage!.prompt_tokens + done!.usage!.completion_tokens,
    );
    if (done!.usage!.cached_tokens != null) {
      expect(done!.usage!.cached_tokens).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it('stream() cost is consistent with chat() cost for equivalent requests', async () => {
    // Run both paths and verify costs are in the same order of magnitude.
    // Exact equality is not expected — token counts differ per call.
    const chatResp = await provider.chat(messages, opts);
    const chunks = await collectChunks(provider.stream(messages, opts));
    const streamDone = getDone(chunks)!;

    expect(chatResp.cost).toBeGreaterThan(0);
    expect(streamDone.cost).toBeGreaterThan(0);

    // Both should be within 10x of each other for the same simple prompt
    const ratio = chatResp.cost! / streamDone.cost!;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  }, 60_000);

  it('chat() reflects 25% cache discount on repeated long-prompt calls', async () => {
    // gpt-4.1-nano cache multiplier = 0.25 (25% of input rate)
    const longMessages: ChatMessage[] = [
      { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
      { role: 'user', content: 'Say hi.' },
    ];
    const cacheOpts = { model, maxTokens: 10 };

    // First call seeds the cache (may already be warm from a previous test run)
    const first = await provider.chat(longMessages, cacheOpts);
    expect(first.cost).toBeGreaterThan(0);
    expect(first.usage!.prompt_tokens).toBeGreaterThan(1000);

    // Second call should hit the cache
    const second = await provider.chat(longMessages, cacheOpts);
    expect(second.cost).toBeGreaterThan(0);
    expect(second.usage!.prompt_tokens).toBeGreaterThan(1000);

    if (second.usage!.cached_tokens && second.usage!.cached_tokens > 0) {
      // Cache hit: cost must be lower than an equivalent uncached call
      expect(second.usage!.cached_tokens).toBeLessThanOrEqual(second.usage!.prompt_tokens);
      // With 25% cache multiplier, total cost must be less than full-price
      // (unless the first call also hit cache, in which case both are discounted)
      if (!first.usage!.cached_tokens) {
        expect(second.cost!).toBeLessThan(first.cost!);
      }
    }
  }, 60_000);

  it('stream() reflects 25% cache discount on repeated long-prompt calls', async () => {
    const longMessages: ChatMessage[] = [
      { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
      { role: 'user', content: 'Say hi.' },
    ];
    const cacheOpts = { model, maxTokens: 10 };

    // Seed
    await collectChunks(provider.stream(longMessages, cacheOpts));

    // Second call
    const chunks = await collectChunks(provider.stream(longMessages, cacheOpts));
    const done = getDone(chunks)!;

    expect(done.cost).toBeGreaterThan(0);
    expect(done.usage!.prompt_tokens).toBeGreaterThan(1000);
    if (done.usage!.cached_tokens && done.usage!.cached_tokens > 0) {
      expect(done.usage!.cached_tokens).toBeLessThanOrEqual(done.usage!.prompt_tokens);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Pricing Integration: OpenAI Responses API', () => {
  let provider: OpenAIResponsesProvider;
  const model = 'gpt-4.1-nano';
  const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly one word: Hello' }];
  const opts = { model, maxTokens: 16 }; // Responses API minimum is 16

  beforeAll(() => {
    provider = new OpenAIResponsesProvider();
  });

  it('chat() returns a positive cost and well-shaped usage', async () => {
    const response = await provider.chat(messages, opts);

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
  }, 30_000);

  it('stream() done chunk contains cost and well-shaped usage', async () => {
    const chunks = await collectChunks(provider.stream(messages, opts));
    const done = getDone(chunks);

    expect(done).toBeDefined();
    expect(done!.cost).toBeTypeOf('number');
    expect(done!.cost).toBeGreaterThan(0);

    expect(done!.usage).toBeDefined();
    expect(done!.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done!.usage!.completion_tokens).toBeGreaterThan(0);
    expect(done!.usage!.total_tokens).toBe(
      done!.usage!.prompt_tokens + done!.usage!.completion_tokens,
    );
  }, 30_000);

  it('stream() cost is consistent with chat() cost for equivalent requests', async () => {
    const chatResp = await provider.chat(messages, opts);
    const chunks = await collectChunks(provider.stream(messages, opts));
    const streamDone = getDone(chunks)!;

    expect(chatResp.cost).toBeGreaterThan(0);
    expect(streamDone.cost).toBeGreaterThan(0);

    const ratio = chatResp.cost! / streamDone.cost!;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  }, 60_000);

  it('chat() cost and usage correct for reasoning model (o4-mini)', async () => {
    // Reasoning models return a different response shape with
    // output_tokens_details.reasoning_tokens — verify cost still works.
    const response = await provider.chat(
      [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
      { model: 'o4-mini', maxTokens: 256, effort: 'low' },
    );

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
    // reasoning_tokens may be 0 with effort: 'low' on trivial questions
    expect(response.usage!.reasoning_tokens ?? 0).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('stream() cost and usage correct for reasoning model (o4-mini)', async () => {
    const chunks = await collectChunks(
      provider.stream([{ role: 'user', content: 'What is 2+2? Reply with just the number.' }], {
        model: 'o4-mini',
        maxTokens: 256,
        effort: 'low',
      }),
    );
    const done = getDone(chunks)!;

    expect(done.usage).toBeDefined();
    expect(done.cost).toBeTypeOf('number');
    expect(done.cost).toBeGreaterThan(0);

    expect(done.usage).toBeDefined();
    expect(done.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done.usage!.completion_tokens).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('Pricing Integration: Anthropic', () => {
  let provider: AnthropicProvider;
  const model = 'claude-haiku-4-5';
  const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly one word: Hello' }];
  const opts = { model, maxTokens: 10 };

  beforeAll(() => {
    provider = new AnthropicProvider();
  });

  it('chat() returns a positive cost and well-shaped usage', async () => {
    const response = await provider.chat(messages, opts);

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    // Anthropic: total = input (incl. cache tokens) + output
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
    if (response.usage!.cached_tokens != null) {
      expect(response.usage!.cached_tokens).toBeGreaterThanOrEqual(0);
      expect(response.usage!.cached_tokens).toBeLessThanOrEqual(response.usage!.prompt_tokens);
    }
  }, 30_000);

  it('stream() done chunk contains cost and well-shaped usage', async () => {
    const chunks = await collectChunks(provider.stream(messages, opts));
    const done = getDone(chunks);

    expect(done).toBeDefined();
    expect(done!.cost).toBeTypeOf('number');
    expect(done!.cost).toBeGreaterThan(0);

    expect(done!.usage).toBeDefined();
    expect(done!.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done!.usage!.completion_tokens).toBeGreaterThan(0);
    if (done!.usage!.cached_tokens != null) {
      expect(done!.usage!.cached_tokens).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it('stream() cost is consistent with chat() cost for equivalent requests', async () => {
    const chatResp = await provider.chat(messages, opts);
    const chunks = await collectChunks(provider.stream(messages, opts));
    const streamDone = getDone(chunks)!;

    expect(chatResp.cost).toBeGreaterThan(0);
    expect(streamDone.cost).toBeGreaterThan(0);

    const ratio = chatResp.cost! / streamDone.cost!;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  }, 60_000);

  it('chat() cost and usage correct for thinking model (claude-sonnet-4-6)', async () => {
    // Thinking models return extra content blocks (type: 'thinking').
    // Verify cost and usage are still parsed correctly.
    const response = await provider.chat(
      [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
      { model: 'claude-sonnet-4-6', maxTokens: 1024, effort: 'low' },
    );

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
  }, 30_000);

  it('stream() cost and usage correct for thinking model (claude-sonnet-4-6)', async () => {
    const chunks = await collectChunks(
      provider.stream([{ role: 'user', content: 'What is 2+2? Reply with just the number.' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        effort: 'low',
      }),
    );
    const done = getDone(chunks)!;

    expect(done.usage).toBeDefined();
    expect(done.cost).toBeTypeOf('number');
    expect(done.cost).toBeGreaterThan(0);

    expect(done.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done.usage!.completion_tokens).toBeGreaterThan(0);
  }, 30_000);

  it('chat() tracks cache reads and reduces cost on repeated long-prompt calls', async () => {
    // Anthropic automatic caching kicks in at >1024 tokens.
    // First call: cache write (cost includes 1.25x write premium, no cache reads).
    // Second call: cache read (cost includes 0.1x read rate → significantly cheaper).
    const longMessages: ChatMessage[] = [
      { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
      { role: 'user', content: 'Say hi.' },
    ];
    const cacheOpts = { model, maxTokens: 10 };

    // First call seeds the cache (may already be warm from a previous run)
    const first = await provider.chat(longMessages, cacheOpts);
    expect(first.cost).toBeGreaterThan(0);
    expect(first.usage!.prompt_tokens).toBeGreaterThan(1000);

    const second = await provider.chat(longMessages, cacheOpts);
    expect(second.cost).toBeGreaterThan(0);
    expect(second.usage!.prompt_tokens).toBeGreaterThan(1000);

    if (second.usage!.cached_tokens && second.usage!.cached_tokens > 0) {
      // Cache read: cost must be substantially lower (10% vs 100% input rate)
      expect(second.usage!.cached_tokens).toBeLessThanOrEqual(second.usage!.prompt_tokens);
      if (!first.usage!.cached_tokens) {
        expect(second.cost!).toBeLessThan(first.cost!);
      }
    }
  }, 60_000);

  it('stream() tracks cache reads on repeated long-prompt calls', async () => {
    const longMessages: ChatMessage[] = [
      { role: 'system', content: CACHE_ELIGIBLE_SYSTEM },
      { role: 'user', content: 'Say hi.' },
    ];
    const cacheOpts = { model, maxTokens: 10 };

    // Seed
    await collectChunks(provider.stream(longMessages, cacheOpts));

    // Second call
    const chunks = await collectChunks(provider.stream(longMessages, cacheOpts));
    const done = getDone(chunks)!;

    expect(done.cost).toBeGreaterThan(0);
    expect(done.usage!.prompt_tokens).toBeGreaterThan(1000);
    if (done.usage!.cached_tokens && done.usage!.cached_tokens > 0) {
      expect(done.usage!.cached_tokens).toBeLessThanOrEqual(done.usage!.prompt_tokens);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('Pricing Integration: Gemini', () => {
  let provider: GeminiProvider;
  const model = 'gemini-2.5-flash-lite';
  const messages: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly one word: Hello' }];
  const opts = { model, maxTokens: 10 };

  beforeAll(() => {
    provider = new GeminiProvider();
  });

  it('chat() returns a positive cost and well-shaped usage', async () => {
    const response = await provider.chat(messages, opts);

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    // Gemini totalTokenCount should equal prompt + candidates for non-thinking models
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens,
    );
    if (response.usage!.cached_tokens != null) {
      expect(response.usage!.cached_tokens).toBeGreaterThanOrEqual(0);
      expect(response.usage!.cached_tokens).toBeLessThanOrEqual(response.usage!.prompt_tokens);
    }
  }, 30_000);

  it('stream() done chunk contains cost and well-shaped usage', async () => {
    const chunks = await collectChunks(provider.stream(messages, opts));
    const done = getDone(chunks);

    expect(done).toBeDefined();
    expect(done!.cost).toBeTypeOf('number');
    expect(done!.cost).toBeGreaterThan(0);

    expect(done!.usage).toBeDefined();
    expect(done!.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done!.usage!.completion_tokens).toBeGreaterThan(0);
    expect(done!.usage!.total_tokens).toBe(
      done!.usage!.prompt_tokens + done!.usage!.completion_tokens,
    );
  }, 30_000);

  it('stream() cost is consistent with chat() cost for equivalent requests', async () => {
    const chatResp = await provider.chat(messages, opts);
    const chunks = await collectChunks(provider.stream(messages, opts));
    const streamDone = getDone(chunks)!;

    expect(chatResp.cost).toBeGreaterThan(0);
    expect(streamDone.cost).toBeGreaterThan(0);

    const ratio = chatResp.cost! / streamDone.cost!;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  }, 60_000);

  it('chat() cost and usage correct for thinking model (gemini-2.5-flash)', async () => {
    // Gemini thinking models return thoughtsTokenCount in usageMetadata.
    // Verify cost and usage are still parsed correctly.
    const response = await provider.chat(
      [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
      { model: 'gemini-2.5-flash', maxTokens: 1024, effort: 'low' },
    );

    expect(response.cost).toBeTypeOf('number');
    expect(response.cost).toBeGreaterThan(0);

    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage!.completion_tokens).toBeGreaterThan(0);
    expect(response.usage!.total_tokens).toBeGreaterThan(0);
  }, 30_000);

  it('stream() cost and usage correct for thinking model (gemini-2.5-flash)', async () => {
    const chunks = await collectChunks(
      provider.stream([{ role: 'user', content: 'What is 2+2? Reply with just the number.' }], {
        model: 'gemini-2.5-flash',
        maxTokens: 1024,
        effort: 'low',
      }),
    );
    const done = getDone(chunks)!;

    expect(done.usage).toBeDefined();
    expect(done.cost).toBeTypeOf('number');
    expect(done.cost).toBeGreaterThan(0);

    expect(done.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(done.usage!.completion_tokens).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Budget tracking: streaming path
//
// This exercises the specific bug that was fixed: streaming calls were not
// contributing to ctx.budget() because cost was never set on the response
// built from the stream's done chunk.
//
// The workflow is run via runtime.stream() so the context uses the streaming
// path (onToken set), not the chat() path.
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('Budget tracking: streaming accumulates cost [OpenAI]', () => {
  it('budget.totalCost > 0 after streaming calls', async () => {
    const cheapAgent = agent({
      model: 'openai:gpt-4.1-nano',
      system: 'Reply in one word.',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'budget-stream-openai',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.budget({ cost: '$1.00', onExceed: 'warn' }, async () => {
          await ctx.ask(cheapAgent, 'Say yes.');
          await ctx.ask(cheapAgent, 'Say no.');
          return 'done';
        });
      },
    });
    runtime.register(wf);

    // runtime.stream() forces the streaming code path in context.ts
    const stream = runtime.stream('budget-stream-openai', {});
    const result = (await stream.promise) as {
      value: string;
      budgetExceeded: boolean;
      totalCost: number;
    };

    expect(result.value).toBe('done');
    expect(result.budgetExceeded).toBe(false);
    // KEY ASSERTION: streaming calls must now contribute to totalCost
    expect(result.totalCost).toBeGreaterThan(0);
  }, 60_000);

  it('budget enforces hard_stop across streaming calls', async () => {
    const cheapAgent = agent({
      model: 'openai:gpt-4.1-nano',
      system: 'Reply in one word.',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'budget-hard-stop-stream-openai',
      input: z.object({}),
      handler: async (ctx) => {
        // Tiny budget that will be exceeded after a couple of calls
        return ctx.budget({ cost: '$0.000001', onExceed: 'hard_stop' }, async () => {
          for (let i = 0; i < 10; i++) {
            await ctx.ask(cheapAgent, `Say word ${i}.`);
          }
          return 10;
        });
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('budget-hard-stop-stream-openai', {});
    const result = (await stream.promise) as {
      value: null;
      budgetExceeded: boolean;
      totalCost: number;
    };

    // Should have been stopped by the budget
    expect(result.budgetExceeded).toBe(true);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.value).toBeNull();
  }, 60_000);
});

describe.skipIf(!hasAnthropic)('Budget tracking: streaming accumulates cost [Anthropic]', () => {
  it('budget.totalCost > 0 after streaming calls', async () => {
    const cheapAgent = agent({
      model: 'anthropic:claude-haiku-4-5',
      system: 'Reply in one word.',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'budget-stream-anthropic',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.budget({ cost: '$1.00', onExceed: 'warn' }, async () => {
          await ctx.ask(cheapAgent, 'Say yes.');
          await ctx.ask(cheapAgent, 'Say no.');
          return 'done';
        });
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('budget-stream-anthropic', {});
    const result = (await stream.promise) as {
      value: string;
      budgetExceeded: boolean;
      totalCost: number;
    };

    expect(result.value).toBe('done');
    expect(result.budgetExceeded).toBe(false);
    expect(result.totalCost).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!hasGoogle)('Budget tracking: streaming accumulates cost [Gemini]', () => {
  it('budget.totalCost > 0 after streaming calls', async () => {
    const cheapAgent = agent({
      model: 'google:gemini-2.5-flash-lite',
      system: 'Reply in one word.',
    });

    const runtime = new AxlRuntime();
    const wf = workflow({
      name: 'budget-stream-gemini',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.budget({ cost: '$1.00', onExceed: 'warn' }, async () => {
          await ctx.ask(cheapAgent, 'Say yes.');
          await ctx.ask(cheapAgent, 'Say no.');
          return 'done';
        });
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('budget-stream-gemini', {});
    const result = (await stream.promise) as {
      value: string;
      budgetExceeded: boolean;
      totalCost: number;
    };

    expect(result.value).toBe('done');
    expect(result.budgetExceeded).toBe(false);
    expect(result.totalCost).toBeGreaterThan(0);
  }, 60_000);
});
