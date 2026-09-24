/**
 * Shared fixtures for the accounting / admission / facade suites.
 *
 * These deliberately build tiny hand-written adapters instead of reusing
 * `MockProvider`: the invariants under test are about what an adapter reports
 * (a usable cost, an unusable one, no usage at all, a declared provenance) and
 * a fixture has to be able to say each of those precisely.
 */

import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { ProviderResponse } from '../types.js';

export type ScriptedTurn = {
  content?: string;
  cost?: number;
  costProvenance?: ProviderResponse['costProvenance'];
  usage?: ProviderResponse['usage'];
  /** Reject instead of returning. */
  throws?: unknown;
  tool_calls?: ProviderResponse['tool_calls'];
};

const DEFAULT_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/**
 * A provider whose every turn is spelled out by the test. Records the options
 * it was handed so a suite can assert what the facade threaded through.
 */
export class ScriptedProvider implements Provider {
  readonly name: string;
  readonly calls: ChatOptions[] = [];
  private index = 0;

  constructor(
    private readonly turns: ScriptedTurn[],
    options?: { name?: string },
  ) {
    this.name = options?.name ?? 'scripted';
  }

  private nextTurn(options: ChatOptions): ScriptedTurn {
    this.calls.push(options);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)] ?? {};
    this.index += 1;
    return turn;
  }

  async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const turn = this.nextTurn(options);
    if (turn.throws !== undefined) throw turn.throws;
    return {
      content: turn.content ?? 'ok',
      ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}),
      usage: 'usage' in turn ? turn.usage : DEFAULT_USAGE,
      cost: turn.cost,
      ...(turn.costProvenance ? { costProvenance: turn.costProvenance } : {}),
    };
  }

  async *stream(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const turn = this.nextTurn(options);
    if (turn.throws !== undefined) throw turn.throws;
    yield { type: 'text_delta', content: turn.content ?? 'ok' };
    yield {
      type: 'done',
      usage: 'usage' in turn ? turn.usage : DEFAULT_USAGE,
      cost: turn.cost,
      ...(turn.costProvenance ? { costProvenance: turn.costProvenance } : {}),
    };
  }
}

/** A runtime with one scripted provider registered as the default. */
export function scriptedRuntime(
  turns: ScriptedTurn[],
  options?: { name?: string },
): { runtime: AxlRuntime; provider: ScriptedProvider } {
  const name = options?.name ?? 'scripted';
  const provider = new ScriptedProvider(turns, { name });
  const runtime = new AxlRuntime({ defaultProvider: name });
  runtime.registerProvider(name, provider);
  return { runtime, provider };
}

/** A one-ask workflow, registered and ready to `runtime.execute('ask', …)`. */
export function registerAskWorkflow(
  runtime: AxlRuntime,
  options?: { name?: string; model?: string; afterAsk?: () => void | Promise<void> },
): string {
  const name = options?.name ?? 'ask';
  const asker = agent({
    name: `${name}-agent`,
    model: options?.model ?? 'scripted:m',
    system: 'you are a fixture',
  });
  runtime.register(
    workflow({
      name,
      input: z.any(),
      handler: async (ctx) => {
        const answer = await ctx.ask(asker, 'go');
        await options?.afterAsk?.();
        return answer;
      },
    }),
  );
  return name;
}

/** A promise a test resolves by hand, for ordering without sleeps. */
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
