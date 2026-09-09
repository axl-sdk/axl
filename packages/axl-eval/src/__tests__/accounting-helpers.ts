/**
 * Instrumented fixtures for the eval accounting / budget suites.
 *
 * These build a REAL `AxlRuntime` with a hand-written provider rather than a
 * duck-typed mock, because the whole point of the 0.24 accounting rail is that
 * spend is measured by the runtime, not reported by the caller. A `{} as
 * AxlRuntime` measures nothing, so any test asserting a cost against one is
 * asserting the uninstrumented path — which is a real path with its own tests,
 * but not the one these suites are about.
 *
 * The provider is hand-written instead of `MockProvider` so a test can say
 * precisely what an adapter reported: a usable cost, a `$0`, usage with no
 * cost, or nothing at all. Those four are different accounting outcomes.
 */

import { z } from 'zod';
import { AxlRuntime, agent, workflow } from '@axlsdk/axl';
import type {
  AxlRuntime as AxlRuntimeType,
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderResponse,
  StreamChunk,
} from '@axlsdk/axl';

export type ScriptedTurn = {
  content?: string;
  /** Omit for "the adapter reported no cost"; `0` means known-free. */
  cost?: number;
  /** Omit entirely (`usage: null`) for "no usage reported at all". */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  /** Reject instead of returning. */
  throws?: unknown;
};

const DEFAULT_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/**
 * A provider whose every turn is spelled out by the test.
 *
 * `onCall` runs BEFORE the turn is produced and is awaited, which is how the
 * concurrency cases hold a call "dispatched" without a timer.
 */
export class ScriptedProvider implements Provider {
  readonly name: string;
  /** Bare model names as the adapter saw them, in call order. */
  readonly calls: string[] = [];
  private index = 0;

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly options?: { name?: string; onCall?: (index: number) => Promise<void> | void },
  ) {
    this.name = options?.name ?? 'mock';
  }

  get callCount(): number {
    return this.calls.length;
  }

  async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const index = this.index++;
    this.calls.push(options.model ?? '(unspecified)');
    await this.options?.onCall?.(index);
    // The last scripted turn repeats, so a test only spells out what varies.
    const turn = this.turns[Math.min(index, this.turns.length - 1)] ?? {};
    if (turn.throws !== undefined) throw turn.throws;
    return {
      content: turn.content ?? 'ok',
      ...(turn.usage === null ? {} : { usage: turn.usage ?? DEFAULT_USAGE }),
      ...('cost' in turn ? { cost: turn.cost } : {}),
    };
  }

  /** Same turn script as `chat`, settled on the `done` chunk. */
  async *stream(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.chat(_messages, options);
    yield { type: 'text_delta', content: response.content };
    yield { type: 'done', usage: response.usage, cost: response.cost };
  }
}

/** A runtime with one scripted provider registered as the default. */
export function scriptedRuntime(
  turns: ScriptedTurn[],
  options?: { name?: string; onCall?: (index: number) => Promise<void> | void },
): { runtime: AxlRuntimeType; provider: ScriptedProvider } {
  const name = options?.name ?? 'mock';
  const provider = new ScriptedProvider(turns, { ...options, name });
  const runtime = new AxlRuntime({ defaultProvider: name, trace: { enabled: false } });
  runtime.registerProvider(name, provider);
  return { runtime, provider };
}

/** The agent every fixture workflow asks. Its URI matches `scriptedRuntime`'s default. */
export const fixtureAgent = agent({ name: 'fixture', model: 'mock:m', system: 'fixture' });

/**
 * An `executeWorkflow` that performs `askCount` asks through the runtime, so
 * every call settles in whatever accounting scope the runner opened.
 *
 * `afterAsks` runs once the asks are done — the hook a case uses to throw after
 * spending, which is the behavior E3 is about.
 */
export function askExecute(options?: {
  askCount?: number;
  afterAsks?: (input: unknown) => void | Promise<void>;
  callerCost?: number;
  callerMetadata?: Record<string, unknown>;
}): (
  input: unknown,
  runtime: AxlRuntimeType,
) => Promise<{
  output: unknown;
  cost?: number;
  metadata?: Record<string, unknown>;
}> {
  return async (input, runtime) => {
    const ctx = runtime.createContext();
    for (let i = 0; i < (options?.askCount ?? 1); i++) {
      await ctx.ask(fixtureAgent, `turn ${i}`);
    }
    await options?.afterAsks?.(input);
    return {
      output: 'out',
      ...(options?.callerCost !== undefined ? { cost: options.callerCost } : {}),
      ...(options?.callerMetadata ? { metadata: options.callerMetadata } : {}),
    };
  };
}

/** Register a one-ask workflow so `runtime.eval()` / `runRegisteredEval` have one. */
export function registerAskWorkflow(runtime: AxlRuntimeType, name = 'ask-wf'): string {
  runtime.register(
    workflow({
      name,
      input: z.any(),
      handler: async (ctx) => ctx.ask(fixtureAgent, 'go'),
    }),
  );
  return name;
}

/** A promise a test resolves by hand, for ordering without timers. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
