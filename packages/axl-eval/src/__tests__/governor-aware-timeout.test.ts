import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, MemoryStore, OpenAIProvider, agent, tool } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { runEval } from '../runner.js';
import type { EvalConfig, EvalResult } from '../types.js';

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const originalFetch = globalThis.fetch;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function config(): EvalConfig {
  return {
    workflow: 'governed',
    dataset: dataset({
      name: 'one-item',
      schema: z.object({ prompt: z.string() }),
      items: [{ input: { prompt: 'go' } }],
    }) as EvalConfig['dataset'],
    scorers: [],
    concurrency: 1,
    failOnItemErrorRate: 1,
  };
}

const nextTurn = tool({
  name: 'next_turn',
  description: 'force a second model turn',
  input: z.object({}),
  handler: async () => 'done',
});

const toolResponse = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'next',
            type: 'function',
            function: { name: 'next_turn', arguments: '{}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage,
};
const finalResponse = {
  choices: [{ message: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }],
  usage,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runEval governor-aware ask timeout', () => {
  it.each([true, false])(
    'keeps a %s multi-turn ask healthy after a long real permit wait plus short work',
    async (multiTurn) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const firstEntered = deferred();
      const releaseFirst = deferred();
      let fetches = 0;
      globalThis.fetch = (async () => {
        const index = fetches++;
        if (index === 0) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        if (index === 1) await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => (index === 1 && multiTurn ? toolResponse : finalResponse),
          text: async () => '',
        };
      }) as typeof fetch;

      // A built-in adapter uses its real one-permit RateLimiter. The blocker
      // holds that permit while the eval item's first provider turn queues.
      const runtime = new AxlRuntime({ defaultProvider: 'openai', trace: { enabled: false } });
      runtime.registerProvider(
        'openai',
        new OpenAIProvider({
          apiKey: 'test-key',
          rateLimit: { maxConcurrent: 1, adaptive: false },
        }),
      );
      const blocker = runtime
        .createContext()
        .ask(agent({ name: 'blocker', model: 'openai:gpt-4o', system: 'test' }), 'hold');
      await firstEntered.promise;
      const timedAgent = agent({
        name: 'governed',
        model: 'openai:gpt-4o',
        system: 'test',
        timeout: '60ms',
        ...(multiTurn ? { tools: [nextTurn] } : {}),
      });
      const running = runEval(
        config(),
        async (_input, rt) => ({ output: await rt.createContext().ask(timedAgent, 'go') }),
        runtime,
      );
      await vi.advanceTimersByTimeAsync(50);
      releaseFirst.resolve();
      await vi.advanceTimersByTimeAsync(15);
      await expect(blocker).resolves.toBe('complete');
      const result = await running;
      expect(result.items[0]).toMatchObject({ outcome: 'completed', output: 'complete' });
      expect(result.items[0].duration).toBeGreaterThanOrEqual(65);
      expect(result.items[0].timing?.['openai:gpt-4o']?.queuedMs).toBeGreaterThanOrEqual(50);
      expect(fetches).toBe(multiTurn ? 3 : 2);
    },
  );

  it('persists a real ctx.ask timeout breakdown through eval history save and load', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const store = new MemoryStore();
    const runtime = new AxlRuntime({ defaultProvider: 'controlled', state: { store } });
    let calls = 0;
    runtime.registerProvider('controlled', {
      name: 'controlled',
      chat: async () => {
        calls++;
        entered.resolve();
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          content: '',
          tool_calls: [
            {
              id: 'next',
              type: 'function',
              function: { name: 'next_turn', arguments: '{}' },
            },
          ],
          usage,
          timing: { queuedMs: 0, retryMs: 0, wireMs: 40, ttfbMs: 40, attempts: 1 },
        };
      },
    } as never);
    const timedAgent = agent({
      name: 'timed',
      model: 'controlled:m',
      system: 'test',
      timeout: '30ms',
      tools: [nextTurn],
    });
    const running = runEval(
      config(),
      async (_input, rt) => ({ output: await rt.createContext().ask(timedAgent, 'go') }),
      runtime,
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(40);
    const result = await running;
    expect(calls).toBe(1); // timeout is checked before the next turn
    expect(result.items[0].outcome).toBe('failed');
    expect(result.items[0].failure).toMatchObject({
      name: 'TimeoutError',
      elapsedMs: 40,
      chargedMs: 40,
      queuedMs: 0,
      retryMs: 0,
      wireMs: 40,
      otherMs: 0,
    });
    expect(result.items[0].duration).toBe(40);

    await runtime.saveEvalResult({
      id: result.id,
      eval: result.dataset,
      timestamp: Date.now(),
      data: result,
    });
    const reader = new AxlRuntime({ state: { store } });
    const loaded = (await reader.getEvalHistory())[0].data as EvalResult;
    expect(loaded.items[0].failure).toEqual(result.items[0].failure);
    expect(loaded.items[0].duration).toBe(result.items[0].duration);
  });
});
