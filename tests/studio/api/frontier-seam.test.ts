import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AxlRuntime,
  MemoryStore,
  agent,
  workflow,
  type Provider,
  type ProviderResponse,
  type StreamChunk,
} from '@axlsdk/axl';
import { createServer } from '@axlsdk/studio';
import { readJson } from '../helpers/json.js';

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const reset = {
  droppedBlocks: 2,
  reasons: { prefix_binding_mismatch: 1, model_binding_mismatch: 1 },
};

/** Deliberately exposes only the normalized Anthropic diagnostic at the adapter boundary. */
function sequenceProvider(): Provider {
  const replies: ProviderResponse[] = [
    {
      content: 'first-secret-output',
      usage,
      cost: 0.01,
      diagnostics: { reasoningContextReset: reset },
    },
    { content: 'middle-secret-output', usage },
    {
      content: 'last-secret-output',
      usage,
      cost: 0.02,
      diagnostics: { reasoningContextReset: reset },
    },
  ];
  let index = 0;
  return {
    name: 'anthropic',
    async chat() {
      return replies[index++]!;
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      const reply = replies[index++]!;
      yield { type: 'text_delta', content: reply.content };
      yield {
        type: 'done',
        usage: reply.usage,
        cost: reply.cost,
        diagnostics: reply.diagnostics,
      };
    },
  };
}

function resetEvents(events: readonly { type: string; step?: number; data?: unknown }[]) {
  return events.filter(
    (event) =>
      event.type === 'provider_diagnostic' &&
      (event.data as { kind?: string } | undefined)?.kind === 'reasoning_context_reset',
  );
}

describe('frontier reset and lower-bound Studio seam', () => {
  it('counts priced, unpriced, then priced calls once in authoritative accounting', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('anthropic', sequenceProvider());
    const worker = agent({
      name: 'accounting-worker',
      model: 'anthropic:claude-opus-5-5',
      system: 'Test system',
    });
    runtime.register(
      workflow({
        name: 'accounting-seam',
        input: z.string(),
        handler: async (ctx) => {
          await ctx.ask(worker, 'first');
          await ctx.ask(worker, 'middle');
          await ctx.ask(worker, 'last');
          return 'complete';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('accounting-seam', 'run'));
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBeCloseTo(0.03);
    expect(outcome.accounting.completeness).toBe('incomplete');
    expect(outcome.accounting.reasons.unpriced_model).toBe(1);
    expect(outcome.accounting.operations).toMatchObject({ total: 3, settled: 2, unknown: 1 });
  });

  it('persists affected/unaffected/affected calls and replays only safe diagnostics through REST and WS', async () => {
    const store = new MemoryStore();
    const runtime = new AxlRuntime({ state: { store }, trace: { redact: true } });
    runtime.registerProvider('anthropic', sequenceProvider());
    const worker = agent({
      name: 'frontier-worker',
      model: 'anthropic:claude-opus-5-5',
      system: 'Test system',
    });
    let budgetSnapshot: { totalCost: number; unpriced: boolean } | undefined;
    runtime.register(
      workflow({
        name: 'frontier-seam',
        input: z.string(),
        handler: async (ctx) => {
          const result = await ctx.budget({ cost: '$1' }, async () => {
            await ctx.ask(worker, 'first-secret-prompt');
            await ctx.ask(worker, 'middle-secret-prompt');
            await ctx.ask(worker, 'last-secret-prompt');
            return 'complete';
          });
          budgetSnapshot = { totalCost: result.totalCost, unpriced: result.unpriced };
          return result.value;
        },
      }),
    );
    const { app, connMgr } = createServer({ runtime });
    const broadcast = vi.spyOn(connMgr, 'broadcastWithWildcard');

    const started = await readJson(
      await app.request('/api/workflows/frontier-seam/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'secret-input', stream: true }),
      }),
    );
    expect(started.ok).toBe(true);
    const channel = `execution:${started.data.executionId}`;
    await expect
      .poll(() =>
        broadcast.mock.calls.some(
          ([ch, event]) => ch === channel && (event as { type?: string }).type === 'done',
        ),
      )
      .toBe(true);

    const [stored] = await store.listExecutions();
    expect(stored).toBeDefined();
    expect(stored.totalCost).toBeCloseTo(0.03);
    expect(stored.unpriced).toBe(true);
    expect(budgetSnapshot).toEqual({ totalCost: 0.03, unpriced: true });
    const storedResets = resetEvents(stored.events);
    expect(storedResets).toHaveLength(2);
    expect(storedResets[0].step).toBeLessThan(storedResets[1].step!);
    expect(storedResets.map((event) => event.data)).toEqual([
      {
        kind: 'reasoning_context_reset',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ...reset,
      },
      {
        kind: 'reasoning_context_reset',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ...reset,
      },
    ]);

    const detail = await readJson(await app.request(`/api/executions/${stored.executionId}`));
    expect(detail.ok).toBe(true);
    expect(detail.data.totalCost).toBeCloseTo(0.03);
    expect(detail.data.unpriced).toBe(true);
    expect(resetEvents(detail.data.events)).toEqual(storedResets);
    const serializedRest = JSON.stringify(detail.data);
    expect(serializedRest).not.toMatch(/secret-(input|prompt|output)|signed-secret|messages\./);

    // Studio's real connection manager serializes and replays the same channel
    // to a subscriber arriving after the workflow completed.
    const frames: unknown[] = [];
    const socket = { send: (value: string) => frames.push(JSON.parse(value)) };
    connMgr.add(socket);
    connMgr.subscribe(socket, channel);
    const replayed = frames
      .filter(
        (frame): frame is { data: { type: string; data?: { kind?: string } } } =>
          typeof frame === 'object' && frame !== null && 'data' in frame,
      )
      .map((frame) => frame.data);
    expect(resetEvents(replayed)).toEqual(storedResets);
    expect(JSON.stringify(frames)).not.toMatch(
      /secret-(input|prompt|output)|signed-secret|messages\./,
    );
    connMgr.remove(socket);
  });
});
