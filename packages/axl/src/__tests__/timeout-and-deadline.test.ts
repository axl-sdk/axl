import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { StallTimeoutError, TimeoutError } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { tool } from '../tool.js';

/**
 * Contract tests for spec 23.  The provider deliberately waits on the signal
 * instead of faking an error: this proves the runtime composes and delivers
 * the signal at the provider boundary, which is the only boundary an adapter
 * can reliably abort.
 */
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function abortableWait(signal: AbortSignal | undefined, ms = 10_000): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => reject(new Error('test provider did not abort')), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function context(provider: object, options: Record<string, unknown> = {}) {
  const registry = new ProviderRegistry();
  registry.registerInstance('controlled', provider as never);
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: crypto.randomUUID(),
    config: { defaultProvider: 'controlled', ...(options.config as object) },
    providerRegistry: registry,
    awaitHumanHandler: options.awaitHumanHandler as never,
    signal: options.signal as AbortSignal | undefined,
  });
  return ctx;
}

function streamingContext(provider: object, options: Record<string, unknown> = {}) {
  const ctx = context(provider, options);
  // Allocating the public event stream is the supported way an ad-hoc context
  // selects provider streaming; no private transport flag is involved.
  void ctx.events;
  return ctx;
}

const baseAgent = (overrides: Record<string, unknown> = {}) =>
  agent({
    name: 'deadline-agent',
    model: 'controlled:model',
    system: 'test',
    ...overrides,
  } as never);

describe('ctx.ask timeout and deadline contract (spec 23)', () => {
  it('T1: finishes an in-flight turn/tool but refuses its next turn after graceful timeout', async () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      const provider = {
        name: 'controlled',
        chat: async (_messages: unknown, options: unknown) => {
          calls.push(options);
          if (calls.length === 1) {
            await wait(60);
            return {
              content: '',
              tool_calls: [
                { id: 'slow', type: 'function', function: { name: 'slow_tool', arguments: '{}' } },
              ],
              usage,
            };
          }
          return { content: 'must not dispatch', usage };
        },
        stream: async function* () {},
      };
      const slowTool = tool({
        name: 'slow_tool',
        description: 'ordinary work',
        input: z.object({}),
        handler: async () => {
          await wait(20);
          return 'finished';
        },
      });
      const ask = context(provider).ask(baseAgent({ timeout: '50ms', tools: [slowTool] }), 'go');
      const rejected = expect(ask).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(81);
      await rejected;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T2–T3: excludes awaitHuman wait, but counts ordinary tool time against graceful timeout', async () => {
    vi.useFakeTimers();
    try {
      const responses = () => {
        let call = 0;
        return {
          name: 'controlled',
          chat: async () => {
            call++;
            if (call === 1) {
              return {
                content: '',
                tool_calls: [
                  { id: 'wait', type: 'function', function: { name: 'approval', arguments: '{}' } },
                ],
                usage,
              };
            }
            return { content: 'after tool', usage };
          },
          stream: async function* () {},
        };
      };
      const approval = tool({
        name: 'approval',
        description: 'wait for a person',
        input: z.object({}),
        handler: async (_input, ctx) => ctx.awaitHuman({ channel: 'test', prompt: 'continue?' }),
      });
      const humanAsk = context(responses(), {
        awaitHumanHandler: async () => {
          await wait(100);
          return { approved: true };
        },
      }).ask(baseAgent({ timeout: '50ms', tools: [approval] }), 'go');
      const humanResult = expect(humanAsk).resolves.toBe('after tool');
      await vi.advanceTimersByTimeAsync(101);
      await humanResult;

      const ordinary = tool({
        name: 'approval',
        description: 'ordinary slow tool',
        input: z.object({}),
        handler: async () => {
          await wait(100);
          return 'late';
        },
      });
      const ordinaryAsk = context(responses()).ask(
        baseAgent({ timeout: '50ms', tools: [ordinary] }),
        'go',
      );
      const ordinaryResult = expect(ordinaryAsk).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(101);
      await ordinaryResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it('T4–T6: stalls a silent stream and resets on every chunk kind', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const firstChunk = deferred<void>();
      const silent = {
        name: 'controlled',
        chat: async () => ({ content: '', usage }),
        stream: async function* (_messages: unknown, options: { signal?: AbortSignal }) {
          yield { type: 'text_delta' as const, content: 'first' };
          firstChunk.resolve();
          try {
            await abortableWait(options.signal);
          } catch (error) {
            sawAbort = true;
            throw error;
          }
        },
      };
      const stalled = streamingContext(silent).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const stalledResult = expect(stalled).rejects.toBeInstanceOf(StallTimeoutError);
      // The generator has yielded the first protocol chunk before the idle
      // window starts. Advancing before this barrier would test scheduler
      // ordering rather than the chunk-reset contract.
      await firstChunk.promise;
      await vi.advanceTimersByTimeAsync(51);
      await stalledResult;
      expect(sawAbort).toBe(true);

      const thinking = deferred<void>();
      const text = deferred<void>();
      const releaseText = deferred<void>();
      const releaseDone = deferred<void>();
      const progressing = {
        name: 'controlled',
        chat: async () => ({ content: '', usage }),
        stream: async function* () {
          yield { type: 'thinking_delta' as const, content: 'thought' };
          thinking.resolve();
          await releaseText.promise;
          yield { type: 'text_delta' as const, content: 'done' };
          text.resolve();
          await releaseDone.promise;
          yield { type: 'done' as const, usage };
        },
      };
      const complete = streamingContext(progressing).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const completeResult = expect(complete).resolves.toBe('done');
      await thinking.promise;
      await vi.advanceTimersByTimeAsync(40);
      releaseText.resolve();
      await text.promise;
      await vi.advanceTimersByTimeAsync(40);
      releaseDone.resolve();
      await completeResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it('T7: applies stallTimeout as a total bound to a non-streaming request', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const provider = {
        name: 'controlled',
        chat: async (_messages: unknown, options: { signal?: AbortSignal }) => {
          try {
            return await abortableWait(options.signal);
          } catch (error) {
            sawAbort = true;
            throw error;
          }
        },
        stream: async function* () {},
      };
      const ask = context(provider).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const stalled = expect(ask).rejects.toBeInstanceOf(StallTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await stalled;
      expect(sawAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T7: a provider that returns late despite its aborted request signal still fails as StallTimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const provider = {
        name: 'controlled',
        chat: async () => {
          await wait(100); // Intentionally ignores ChatOptions.signal.
          return { content: 'late success must not escape', usage };
        },
        stream: async function* () {},
      };
      const ask = context(provider).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const outcome = ask.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(101);
      expect((await outcome).error).toBeInstanceOf(StallTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T8–T10: propagates exact per-ask abort reasons, rejects pre-abort before dispatch, and is first-wins with context signal', async () => {
    const calls: { signal?: AbortSignal }[] = [];
    const provider = {
      name: 'controlled',
      chat: async (_messages: unknown, options: { signal?: AbortSignal }) => {
        calls.push(options);
        return abortableWait(options.signal);
      },
      stream: async function* () {},
    };
    const exactReason = new Error('caller abort');
    const controller = new AbortController();
    const pending = context(provider).ask(baseAgent(), 'go', {
      signal: controller.signal,
    } as never);
    controller.abort(exactReason);
    await expect(pending).rejects.toBe(exactReason);
    expect(calls[0].signal?.aborted).toBe(true);

    const preAborted = new AbortController();
    const preReason = new Error('already cancelled');
    preAborted.abort(preReason);
    await expect(
      context(provider).ask(baseAgent(), 'go', { signal: preAborted.signal } as never),
    ).rejects.toBe(preReason);
    expect(calls).toHaveLength(1);

    const contextController = new AbortController();
    const askController = new AbortController();
    const contextReason = new Error('context wins');
    const race = context(provider, { signal: contextController.signal }).ask(baseAgent(), 'go', {
      signal: askController.signal,
    } as never);
    contextController.abort(contextReason);
    askController.abort(new Error('too late'));
    await expect(race).rejects.toBe(contextReason);

    const lateContext = new AbortController();
    const firstAsk = new AbortController();
    const askReason = new Error('ask wins');
    const askFirst = context(provider, { signal: lateContext.signal }).ask(baseAgent(), 'go', {
      signal: firstAsk.signal,
    } as never);
    firstAsk.abort(askReason);
    lateContext.abort(new Error('too late'));
    await expect(askFirst).rejects.toBe(askReason);
  });

  it('T11–T12: per-ask signal is sibling-local and inherited by an agent-as-tool nested ask', async () => {
    const entered: AbortSignal[] = [];
    let siblingCall = 0;
    const provider = {
      name: 'controlled',
      chat: async (_messages: unknown, options: { signal?: AbortSignal }) => {
        entered.push(options.signal!);
        siblingCall++;
        if (siblingCall === 2) return { content: 'sibling completes', usage };
        return abortableWait(options.signal);
      },
      stream: async function* () {},
    };
    const ctx = context(provider);
    const first = new AbortController();
    const cancelled = ctx.ask(baseAgent(), 'first', { signal: first.signal } as never);
    const sibling = ctx.ask(baseAgent(), 'second');
    first.abort(new Error('only first'));
    await expect(cancelled).rejects.toThrow('only first');
    await expect(sibling).resolves.toBe('sibling completes');
    expect(entered).toHaveLength(2);
    // An unscoped sibling is permitted to receive no signal at all; either
    // shape proves the cancelled ask did not mutate context-wide state.
    expect(entered[1]?.aborted ?? false).toBe(false);

    const inner = baseAgent({ name: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'nested ask',
      input: z.object({}),
      handler: async (_input, toolCtx) => toolCtx.ask(inner, 'nested'),
    });
    let turn = 0;
    let nestedSignal: AbortSignal | undefined;
    const nestedProvider = {
      name: 'controlled',
      chat: async (_messages: unknown, options: { signal?: AbortSignal }) => {
        turn++;
        if (turn === 1) {
          return {
            content: '',
            tool_calls: [
              { id: 'inner', type: 'function', function: { name: 'call_inner', arguments: '{}' } },
            ],
            usage,
          };
        }
        nestedSignal = options.signal;
        return abortableWait(options.signal);
      },
      stream: async function* () {},
    };
    const nestedAbort = new AbortController();
    let enteredNested!: () => void;
    const nestedEntered = new Promise<void>((resolve) => {
      enteredNested = resolve;
    });
    const nested = context({
      ...nestedProvider,
      chat: async (messages: unknown, options: { signal?: AbortSignal }) => {
        if (turn === 1) enteredNested();
        return nestedProvider.chat(messages, options);
      },
    }).ask(baseAgent({ tools: [callInner] }), 'outer', { signal: nestedAbort.signal } as never);
    await nestedEntered;
    nestedAbort.abort(new Error('nested inherited abort'));
    await expect(nested).rejects.toThrow();
    expect(nestedSignal?.aborted).toBe(true);
  });

  it('T6/T18: stall timing excludes tools and completed calls leave no late timer contamination', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      let firstSignal: AbortSignal | undefined;
      const provider = {
        name: 'controlled',
        chat: async (_messages: unknown, options: { signal?: AbortSignal }) => {
          call++;
          if (call === 1) {
            firstSignal = options.signal;
            return {
              content: '',
              tool_calls: [
                { id: 'slow', type: 'function', function: { name: 'slow_tool', arguments: '{}' } },
              ],
              usage,
            };
          }
          return { content: 'after slow tool', usage };
        },
        stream: async function* () {},
      };
      const slowTool = tool({
        name: 'slow_tool',
        description: 'ordinary work outside provider request',
        input: z.object({}),
        handler: async () => {
          await wait(100);
          return 'done';
        },
      });
      const ask = context(provider).ask(
        baseAgent({ stallTimeout: '50ms', tools: [slowTool] }),
        'go',
      );
      const result = expect(ask).resolves.toBe('after slow tool');
      await vi.advanceTimersByTimeAsync(101);
      await result;
      expect(firstSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(firstSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T9/T10: lifecycle dispatch starts the clock, retry backoff disarms it, and only post-dispatch silence stalls', async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const dispatchSecond = deferred<void>();
      const provider = {
        name: 'controlled',
        reportsRequestLifecycle: true,
        chat: async (
          _messages: unknown,
          options: {
            signal?: AbortSignal;
            requestLifecycle?: { onDispatch?(): void; onRetry?(): void };
          },
        ) => {
          entered.resolve();
          await dispatchSecond.promise;
          options.requestLifecycle?.onDispatch?.();
          options.requestLifecycle?.onRetry?.();
          await wait(100); // SDK retry/backoff: deliberately longer than the stall window.
          options.requestLifecycle?.onDispatch?.();
          return abortableWait(options.signal);
        },
        stream: async function* () {},
      };
      const ask = context(provider).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const stalled = expect(ask).rejects.toBeInstanceOf(StallTimeoutError);
      await entered.promise;
      // No lifecycle dispatch yet: elapsed provider-entry time is not a stall.
      await vi.advanceTimersByTimeAsync(100);
      dispatchSecond.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      // Backoff has no armed timer; the second dispatch re-arms it.
      await vi.advanceTimersByTimeAsync(51);
      await stalled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('T9: lifecycle dispatch delayed beyond stallTimeout can still complete, while silence after dispatch cannot', async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const release = deferred<void>();
      const provider = {
        name: 'controlled',
        reportsRequestLifecycle: true,
        chat: async (
          _messages: unknown,
          options: {
            requestLifecycle?: { onDispatch?(): void };
          },
        ) => {
          entered.resolve();
          await release.promise;
          options.requestLifecycle?.onDispatch?.();
          return { content: 'prompt after queue', usage };
        },
        stream: async function* () {},
      };
      const ask = context(provider).ask(baseAgent({ stallTimeout: '50ms' }), 'go');
      const complete = expect(ask).resolves.toBe('prompt after queue');
      await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
      release.resolve();
      await complete;
    } finally {
      vi.useRealTimers();
    }
  });

  it('T13–T14: defaults, agent, and ask options each control timeout/stall precedence; unset stall is inert', async () => {
    vi.useFakeTimers();
    try {
      const slowProvider = () => ({
        name: 'controlled',
        chat: async (_messages: unknown, options: { signal?: AbortSignal }) =>
          abortableWait(options.signal),
        stream: async function* () {},
      });
      const defaults = context(slowProvider(), { config: { defaults: { stallTimeout: '50ms' } } });
      const defaultAsk = defaults.ask(baseAgent(), 'go');
      const defaultResult = expect(defaultAsk).rejects.toBeInstanceOf(StallTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await defaultResult;

      const agentWins = context(slowProvider(), { config: { defaults: { stallTimeout: '50ms' } } });
      const agentAsk = agentWins.ask(baseAgent({ stallTimeout: '200ms' }), 'go');
      const agentResult = expect(agentAsk).rejects.toBeInstanceOf(StallTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      // Agent override prevents the default window from firing.
      await vi.advanceTimersByTimeAsync(150);
      await agentResult;

      const askWins = context(slowProvider(), { config: { defaults: { stallTimeout: '200ms' } } });
      const askResult = askWins.ask(baseAgent({ stallTimeout: '150ms' }), 'go', {
        stallTimeout: '50ms',
      });
      const askStalled = expect(askResult).rejects.toBeInstanceOf(StallTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await askStalled;

      const noDefaultStall = context({
        name: 'controlled',
        chat: async () => {
          await wait(100);
          return { content: 'not stalled', usage };
        },
        stream: async function* () {},
      });
      const inert = noDefaultStall.ask(baseAgent(), 'go');
      const inertResult = expect(inert).resolves.toBe('not stalled');
      await vi.advanceTimersByTimeAsync(101);
      await inertResult;

      const nextTurn = tool({
        name: 'next_turn',
        description: 'force a graceful boundary',
        input: z.object({}),
        handler: async () => 'tool result',
      });
      const timeoutProvider = () => {
        let call = 0;
        return {
          name: 'controlled',
          chat: async () => {
            call++;
            if (call === 1) {
              await wait(100);
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
              };
            }
            return { content: 'agent timeout override wins', usage };
          },
          stream: async function* () {},
        };
      };
      const defaultTimeout = context(timeoutProvider(), {
        config: { defaults: { timeout: '50ms' } },
      }).ask(baseAgent({ tools: [nextTurn] }), 'go');
      const defaultTimedOut = expect(defaultTimeout).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(101);
      await defaultTimedOut;

      const agentTimeout = context(timeoutProvider(), {
        config: { defaults: { timeout: '50ms' } },
      }).ask(baseAgent({ timeout: '200ms', tools: [nextTurn] }), 'go');
      const agentCompleted = expect(agentTimeout).resolves.toBe('agent timeout override wins');
      await vi.advanceTimersByTimeAsync(101);
      await agentCompleted;

      const askTimeout = context(timeoutProvider(), {
        config: { defaults: { timeout: '200ms' } },
      }).ask(baseAgent({ timeout: '150ms', tools: [nextTurn] }), 'go', { timeout: '50ms' });
      const askTimedOut = expect(askTimeout).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(101);
      await askTimedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
