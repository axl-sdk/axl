/**
 * Opt-in request capture (plan A10–A12).
 *
 * The product question is "what did we actually submit on the turn after the
 * model's output was rejected?" — so these tests assert the CONTENT of the
 * captured conversation, not merely that a record exists. A capture that keeps
 * the retry label but loses the messages answers nothing.
 *
 * The second theme is subordination: capture is diagnostics, and it must not be
 * able to change spend, delay a provider, or fail a run.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { CapturedRequestRecord } from '../diagnostics/capture.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { ProviderResponse } from '../types.js';
import { deferred, scriptedRuntime, type ScriptedTurn } from './accounting-helpers.js';
import {
  BlockingSink,
  channelWith,
  CollectingSink,
  FailingSink,
  phase,
} from './request-capture-helpers.js';

const Answer = z.object({ value: z.number() });

/** A runtime + workflow that asks once with a schema, so gates can reject it. */
function schemaAskRuntime(
  turns: ScriptedTurn[],
  askOptions?: Record<string, unknown>,
): { runtime: AxlRuntime; provider: { calls: ChatOptions[] } } {
  const { runtime, provider } = scriptedRuntime(turns);
  const asker = agent({ name: 'a', model: 'scripted:m', system: 'fixture' });
  runtime.register(
    workflow({
      name: 'ask',
      input: z.any(),
      handler: async (ctx) => ctx.ask(asker, 'go', { schema: Answer, ...askOptions } as never),
    }),
  );
  return { runtime, provider };
}

/** Run `fn` with capture on and hand back both the records and the outcome. */
async function capture(
  runtime: AxlRuntime,
  fn: () => Promise<unknown>,
  options?: Parameters<typeof channelWith>[1],
): Promise<{ records: CapturedRequestRecord[]; outcome: { status: string; error?: unknown } }> {
  const sink = new CollectingSink();
  const channel = channelWith(sink, options);
  const outcome = await runtime.trackOutcome(fn, { capture: channel });
  await channel.close();
  return { records: sink.records(), outcome };
}

// ── A10: the captured request is what was actually submitted ─────────

describe('A10 — captured request reflects the submitted conversation', () => {
  it('A10.1 keeps the real conversation for BOTH turns of a schema repair', async () => {
    const { runtime } = schemaAskRuntime([
      { content: 'not json at all' },
      { content: '{"value":7}' },
    ]);

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));

    const starts = phase(records, 'start');
    expect(starts).toHaveLength(2);
    // The bug this kills: capture that keeps `retryReason` but strips
    // `messages`, leaving a "retry" record that explains nothing.
    expect(starts[0].request!.messages.length).toBeGreaterThan(0);
    expect(starts[1].request!.messages.length).toBeGreaterThan(starts[0].request!.messages.length);
    // Turn 2 submitted the rejected attempt AND the correction, in that order.
    const turn2 = starts[1].request!.messages;
    expect(turn2.at(-2)).toMatchObject({ role: 'assistant', content: 'not json at all' });
    expect(turn2.at(-1)!.role).toBe('user');
    expect(String(turn2.at(-1)!.content)).toContain('schema');
  });

  it('A10.2 labels a validate rejection distinctly from a schema one', async () => {
    const { runtime, provider } = scriptedRuntime([
      { content: '{"value":1}' },
      { content: '{"value":9}' },
    ]);
    void provider;
    const asker = agent({ name: 'a', model: 'scripted:m', system: 'fixture' });
    runtime.register(
      workflow({
        name: 'ask',
        input: z.any(),
        handler: async (ctx) =>
          ctx.ask(asker, 'go', {
            schema: Answer,
            validate: (o: { value: number }) =>
              o.value > 5 ? { valid: true } : { valid: false, reason: 'too small' },
          } as never),
      }),
    );

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));
    const starts = phase(records, 'start');

    expect(starts[1].retryReason).toBe('validate');
    expect(starts[1].correction).toMatchObject({ stage: 'validate', reason: 'too small' });
    // A single generic "retry" label for every rejection kind is the bug.
    expect(starts[1].correction!.stage).not.toBe('schema');
    expect(String(starts[1].request!.messages.at(-1)!.content)).toContain(
      starts[1].correction!.feedbackMessage,
    );
  });

  it('A10.3 captures a guardrail rejection and the corrected submission', async () => {
    const { runtime } = scriptedRuntime([{ content: 'bad words' }, { content: 'clean words' }]);
    const asker = agent({
      name: 'a',
      model: 'scripted:m',
      system: 'fixture',
      guardrails: {
        onBlock: 'retry',
        maxRetries: 2,
        output: (text: string) =>
          text.includes('bad') ? { block: true, reason: 'contains bad' } : { block: false },
      },
    } as never);
    runtime.register(
      workflow({ name: 'ask', input: z.any(), handler: async (ctx) => ctx.ask(asker, 'go') }),
    );

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));
    const starts = phase(records, 'start');

    expect(starts).toHaveLength(2);
    expect(starts[1].retryReason).toBe('guardrail');
    expect(starts[1].correction).toMatchObject({ stage: 'guardrail', reason: 'contains bad' });
    expect(starts[1].request!.messages.at(-2)).toMatchObject({ content: 'bad words' });
  });

  it('A10.4 captures the caller’s CUSTOM feedback text byte-for-byte', async () => {
    const custom = 'Please answer with {"value": <a number>} and nothing else. [xyzzy-42]';
    const { runtime } = schemaAskRuntime([{ content: 'nope' }, { content: '{"value":3}' }], {
      retryFeedback: () => custom,
    });

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));
    const starts = phase(records, 'start');

    // A synthesized default instead of the real submission is the bug: the
    // exact bytes the model saw are the whole point of the feature.
    expect(starts[1].request!.messages.at(-1)!.content).toBe(custom);
    expect(starts[1].correction!.feedbackMessage).toBe(custom);
  });

  it('A10.5 is immutable: mutating the caller’s arrays after dispatch changes nothing', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'original' }];
    const tools = [
      { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } },
    ];
    const { runtime, provider } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      async () => {
        await facade.chat(messages, { model: 'm', tools });
        // The classic bug: the record holds a live reference, so this mutation
        // rewrites history after the fact.
        messages.push({ role: 'user', content: 'appended later' });
        messages[0].content = 'mutated';
        tools.push({
          type: 'function',
          function: { name: 'sneaky', description: '', parameters: {} },
        });
      },
      { capture: channel },
    );
    await channel.close();
    void provider;

    const start = phase(sink.records(), 'start')[0];
    expect(start.request!.messages).toHaveLength(1);
    expect(start.request!.messages[0].content).toBe('original');
    expect(start.request!.tools!.map((t) => t.name)).toEqual(['t']);
  });

  it('A10.6 snapshots BEFORE the adapter mutates what it was handed', async () => {
    class MutatingProvider implements Provider {
      readonly name = 'mut';
      async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
        messages.push({ role: 'system', content: 'adapter injected this' });
        (options as { stop?: string[] }).stop = ['adapter-added'];
        return {
          content: 'ok',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      }
    }
    const runtime = new AxlRuntime({ defaultProvider: 'mut' });
    runtime.registerProvider('mut', new MutatingProvider());
    const { provider: facade } = runtime.resolveProvider('mut:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: 'hello' }], { model: 'm' }),
      { capture: channel },
    );
    await channel.close();

    const start = phase(sink.records(), 'start')[0];
    expect(start.request!.messages).toHaveLength(1);
    expect(start.request!.options.stop).toBeUndefined();
  });

  it('A10.7 marks a tool continuation as a distinct turn, not an output repair', async () => {
    const { runtime } = scriptedRuntime([
      {
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"v":1}' } },
        ],
      },
      { content: 'done' },
    ]);
    const { tool } = await import('../tool.js');
    const echo = tool({
      name: 'echo',
      description: 'echo',
      input: z.object({ v: z.number() }),
      handler: async ({ v }: { v: number }) => v,
    } as never);
    const asker = agent({ name: 'a', model: 'scripted:m', system: 'fixture', tools: [echo] });
    runtime.register(
      workflow({ name: 'ask', input: z.any(), handler: async (ctx) => ctx.ask(asker, 'go') }),
    );

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));
    const starts = phase(records, 'start');

    expect(starts).toHaveLength(2);
    expect(starts[0].askId).toBe(starts[1].askId);
    expect(starts[0].turn).toBe(1);
    expect(starts[1].turn).toBe(2);
    // A tool continuation is an agent-loop iteration; calling it a repair is
    // the narrative bug this kills.
    expect(starts[1].retryReason).toBeUndefined();
    expect(starts[1].correction).toBeUndefined();
  });

  it('A10.8 keeps nested ask identity reconstructible', async () => {
    const { runtime } = scriptedRuntime([{ content: 'inner' }, { content: 'outer' }]);
    const inner = agent({ name: 'inner', model: 'scripted:m', system: 'fixture' });
    const outer = agent({ name: 'outer', model: 'scripted:m', system: 'fixture' });
    runtime.register(
      workflow({
        name: 'ask',
        input: z.any(),
        handler: async (ctx) => {
          const parent = await ctx.ask(outer, 'parent');
          const child = await ctx.delegate(inner, 'child');
          return `${String(parent)}/${String(child)}`;
        },
      }),
    );

    const { records } = await capture(runtime, () => runtime.execute('ask', {}));
    const starts = phase(records, 'start');

    const askIds = new Set(starts.map((r) => r.askId));
    // Distinct asks must not share an identity, or nesting cannot be rebuilt.
    expect(askIds.size).toBe(starts.length);
    for (const record of starts) {
      expect(record.executionId).toBeTruthy();
      expect(record.turn).toBe(1);
    }
  });

  it('A10.9 records EVERY attempted turn when validation is finally exhausted', async () => {
    const { runtime } = schemaAskRuntime([{ content: 'garbage' }], { retries: 2 });

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(() => runtime.execute('ask', {}), {
      capture: channel,
    });
    await channel.close();

    expect(outcome.status).toBe('rejected');
    const starts = phase(sink.records(), 'start');
    // Capture written only on success is the bug: the exhausted run is exactly
    // the one worth inspecting.
    expect(starts.length).toBe(3);
    expect(starts.map((r) => r.turn)).toEqual([1, 2, 3]);
    expect(starts[2].correction!.stage).toBe('schema');
    // Accounting is untouched by any of this.
    expect(outcome.accounting.operations.total).toBe(3);
  });
});

// ── A11: completeness, fidelity and judges ───────────────────────────

describe('A11 — capture completeness and fidelity', () => {
  it('A11.1 captures tool definitions, response format and resolved options', async () => {
    const { runtime, provider } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    void provider;

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () =>
        facade.chat([{ role: 'user', content: 'hi' }], {
          model: 'gpt-fixture',
          temperature: 0.3,
          maxTokens: 512,
          effort: 'high',
          toolChoice: 'required',
          tools: [
            {
              type: 'function',
              function: {
                name: 'lookup',
                description: 'look things up',
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
              },
            },
          ],
          responseFormat: { type: 'json_object' },
        }),
      { capture: channel },
    );
    await channel.close();

    const start = phase(sink.records(), 'start')[0];
    expect(start.request!.tools).toEqual([
      {
        name: 'lookup',
        description: 'look things up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
    expect(start.request!.responseFormat).toEqual({ type: 'json_object' });
    expect(start.request!.options).toMatchObject({
      model: 'gpt-fixture',
      temperature: 0.3,
      maxTokens: 512,
      effort: 'high',
      toolChoice: 'required',
    });
  });

  it('A11.2 labels fidelity as runtime_request and never claims wire bytes', async () => {
    const { runtime } = schemaAskRuntime([{ content: '{"value":1}' }]);
    const { records } = await capture(runtime, () => runtime.execute('ask', {}));

    for (const record of records) {
      expect(record.captured.fidelity).toBe('runtime_request');
    }
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('"wire"');
    expect(serialized).not.toContain('rawBody');
  });

  it('A11.4 leaves a START record for a call that never returns', async () => {
    const gate = deferred();
    class HangingProvider implements Provider {
      readonly name = 'hang';
      async chat(): Promise<ProviderResponse> {
        await gate.promise;
        return { content: 'never' };
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      }
    }
    const runtime = new AxlRuntime({ defaultProvider: 'hang' });
    runtime.registerProvider('hang', new HangingProvider());
    const { provider: facade } = runtime.resolveProvider('hang:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      async () => {
        // Fire and DON'T await: the scope finalizes with the call in flight.
        void facade.chat([{ role: 'user', content: 'hi' }], { model: 'm' });
        await Promise.resolve();
      },
      { capture: channel },
    );
    await channel.close();
    gate.resolve();

    const records = sink.records();
    expect(phase(records, 'start')).toHaveLength(1);
    // Writing records only at completion loses exactly the hung call.
    expect(phase(records, 'end')).toHaveLength(0);
  });

  it('A11.5 records the error identity, never a fabricated empty response', async () => {
    const boom = new Error('connection reset');
    const { runtime } = scriptedRuntime([{ throws: boom }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: 'hi' }], { model: 'm' }).catch(() => undefined),
      { capture: channel },
    );
    await channel.close();

    const records = sink.records();
    expect(phase(records, 'start')).toHaveLength(1);
    const end = phase(records, 'end')[0];
    expect(end.error).toMatchObject({ message: 'connection reset' });
    // A null response serialized as `{content: ''}` is the bug.
    expect(end.response).toBeUndefined();
  });

  it('A11.6 links transport attempts to ONE operation without relabeling them repairs', async () => {
    class RetryingProvider implements Provider {
      readonly name = 'retry';
      readonly reportsRequestLifecycle = true as const;
      async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
        // Two dispatches, one logical operation — exactly what a 429 + retry
        // looks like from the runtime's side of the transport.
        options.requestLifecycle?.onDispatch?.();
        options.requestLifecycle?.onRetry?.();
        options.requestLifecycle?.onDispatch?.();
        return {
          content: 'ok',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      }
    }
    const runtime = new AxlRuntime({ defaultProvider: 'retry' });
    runtime.registerProvider('retry', new RetryingProvider());
    const { provider: facade } = runtime.resolveProvider('retry:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: 'hi' }], { model: 'm' }),
      { capture: channel },
    );
    await channel.close();

    const records = sink.records();
    const ids = new Set(records.map((r) => r.operationId));
    expect(ids.size).toBe(1);
    const attempts = phase(records, 'attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].transportAttempts).toBe(2);
    // Neither attempt is a retry TURN: no gate rejected anything.
    for (const record of records) expect(record.retryReason).toBeUndefined();
  });

  it('A11.7 describes rich media instead of carrying its bytes', async () => {
    const { runtime } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () =>
        facade.chat(
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image', source: { type: 'url', url: 'https://example.test/x.png' } },
                {
                  type: 'audio',
                  source: { type: 'bytes', data: audioBytes, mediaType: 'audio/wav' },
                },
              ] as never,
            },
          ],
          { model: 'm' },
        ),
      { capture: channel },
    );
    await channel.close();

    const start = phase(sink.records(), 'start')[0];
    expect(start.captured.omitted).toContain('media');
    // Neither a silent drop nor the bytes themselves: a descriptor.
    const message = start.request!.messages[0];
    expect(message.content).toBe('what is this?');
    expect(message.input!.parts.some((p) => p.type === 'image')).toBe(true);
    expect(message.input!.parts.some((p) => p.type === 'audio')).toBe(true);
    expect(JSON.stringify(start)).not.toContain('"data"');
  });

  it('A11.8 captures a stream on first next() and links the done chunk to it', async () => {
    const { runtime } = scriptedRuntime([{ content: 'streamed', cost: 0.02 }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      async () => {
        const iterator = facade.stream([{ role: 'user', content: 'hi' }], { model: 'm' });
        for await (const _chunk of iterator) void _chunk;
      },
      { capture: channel },
    );
    await channel.close();

    const records = sink.records();
    const start = phase(records, 'start')[0];
    const end = phase(records, 'end')[0];
    expect(start.kind).toBe('stream');
    expect(end.operationId).toBe(start.operationId);
    expect(end.response!.cost).toBe(0.02);
  });
});

// ── A12: bounded, private, failure-tolerant ──────────────────────────

describe('A12 — bounded, private, failure-tolerant capture', () => {
  it('A12.1 replaces an oversized record with a stub measured in UTF-8 BYTES', async () => {
    const { runtime } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    // Multi-byte on purpose: counting JS string length would let this through.
    const huge = 'é'.repeat(2000);

    const sink = new CollectingSink();
    const channel = channelWith(sink, { maxRecordBytes: 1024 });
    await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: huge }], { model: 'm' }),
      { capture: channel },
    );
    const status = await channel.close();

    const start = phase(sink.records(), 'start')[0];
    expect(start.captured.truncated).toBe(true);
    expect(start.request).toBeUndefined();
    expect(Buffer.byteLength(sink.lines[0], 'utf-8')).toBeLessThanOrEqual(1024);
    // The stub records how big the thing it replaced actually was.
    expect(start.bytes).toBeGreaterThan(1024);
    expect(status.status).toBe('complete');
  });

  it('A12.2 stops at the run byte limit with an identical accounting result', async () => {
    const turns: ScriptedTurn[] = [{ content: 'x'.repeat(400), cost: 0.01 }];

    const run = async (channel?: ReturnType<typeof channelWith>) => {
      const { runtime } = scriptedRuntime(turns);
      const { provider: facade } = runtime.resolveProvider('scripted:m');
      const outcome = await runtime.trackOutcome(
        async () => {
          for (let i = 0; i < 20; i++) {
            await facade.chat([{ role: 'user', content: 'x'.repeat(400) }], { model: 'm' });
          }
        },
        channel ? { capture: channel } : undefined,
      );
      return outcome.accounting;
    };

    const sink = new CollectingSink();
    const channel = channelWith(sink, { maxRunBytes: 2000 });
    const withCapture = await run(channel);
    const status = await channel.close();
    const withoutCapture = await run();

    expect(status.status).toBe('truncated');
    expect(status.reason).toMatch(/run capture limit/);
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.length).toBeLessThan(40);
    // Capture limits silently disabling settlement is the bug.
    expect(withCapture).toEqual(withoutCapture);
  });

  it('A12.3 never waits on a sink whose writes do not settle', async () => {
    const { runtime } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    const sink = new BlockingSink();
    const channel = channelWith(sink, { maxQueueBytes: 300, flushTimeoutMs: 50 });

    // No timers, no sleeps: awaiting this at all is the assertion. If capture
    // back-pressured the provider, this would never resolve.
    await runtime.trackOutcome(
      async () => {
        for (let i = 0; i < 10; i++) {
          await facade.chat([{ role: 'user', content: 'padding '.repeat(20) }], { model: 'm' });
        }
      },
      { capture: channel },
    );
    const status = await channel.close();
    sink.gate.resolve();

    expect(status.status).toBe('truncated');
    // The reason itself must survive: it is not queued behind the content it
    // is reporting on.
    expect(status.reason).toMatch(/queue/);
  });

  it('A12.4 survives a sink that throws, with spend unchanged', async () => {
    const { runtime } = scriptedRuntime([{ content: 'ok', cost: 0.05 }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    const channel = channelWith(new FailingSink('nope'));

    const outcome = await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: 'hi' }], { model: 'm' }),
      { capture: channel },
    );
    const status = await channel.close();

    expect(outcome.status).toBe('fulfilled');
    expect(status.status).toBe('unavailable');
    expect(status.reason).toMatch(/nope/);
    // An observer failure erasing incurred spend is the bug.
    expect(outcome.accounting.knownCost).toBe(0.05);
    expect(outcome.accounting.completeness).toBe('complete');
  });

  it('A12.5 redacts before the sink sees anything', async () => {
    const secret = 'sk-live-DO-NOT-LEAK-4242';
    const { runtime } = scriptedRuntime([{ content: `echoing ${secret}` }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink, { redact: true });
    await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: `my key is ${secret}` }], { model: 'm' }),
      { capture: channel },
    );
    const status = await channel.close();

    const serialized = sink.lines.join('\n');
    expect(serialized).not.toContain(secret);
    expect(status.redaction).toBe('applied');
    for (const record of sink.records()) expect(record.captured.redacted).toBe(true);
  });

  it('A12.6 records providerOptions KEYS only, never their values', async () => {
    const credential = 'Bearer super-secret-token';
    const { runtime } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      () =>
        facade.chat([{ role: 'user', content: 'hi' }], {
          model: 'm',
          providerOptions: {
            authorization: credential,
            nested: { deeper: { apiKey: credential } },
          },
        }),
      { capture: channel },
    );
    await channel.close();

    const serialized = sink.lines.join('\n');
    // Scanning the SERIALIZED record, not a field: spreading arbitrary options
    // anywhere in the payload is the bug.
    expect(serialized).not.toContain(credential);
    const start = phase(sink.records(), 'start')[0];
    expect(start.request!.providerOptionKeys).toEqual(['authorization', 'nested']);
    expect(start.captured.omitted).toContain('providerOptionValues');
  });

  it('A12.8 keeps the pending queue inside its byte bound', async () => {
    const { runtime } = scriptedRuntime([{ content: 'ok' }]);
    const { provider: facade } = runtime.resolveProvider('scripted:m');
    const sink = new BlockingSink();
    const channel = channelWith(sink, { maxQueueBytes: 400, flushTimeoutMs: 20 });

    await runtime.trackOutcome(
      async () => {
        for (let i = 0; i < 50; i++) {
          await facade.chat([{ role: 'user', content: 'y'.repeat(200) }], { model: 'm' });
        }
      },
      { capture: channel },
    );
    const status = await channel.close();
    sink.gate.resolve();

    // Unbounded buffering would have accepted all 100 records.
    expect(status.records).toBeLessThan(10);
    expect(status.status).toBe('truncated');
  });

  it('A12.10 reports evidence loss WITHOUT touching accounting', async () => {
    const turns: ScriptedTurn[] = [{ content: 'ok', cost: 0.03 }];
    const runOnce = async (channel: ReturnType<typeof channelWith>) => {
      const { runtime } = scriptedRuntime(turns);
      const { provider: facade } = runtime.resolveProvider('scripted:m');
      const outcome = await runtime.trackOutcome(
        () => facade.chat([{ role: 'user', content: 'hi' }], { model: 'm' }),
        { capture: channel },
      );
      return { accounting: outcome.accounting, status: await channel.close() };
    };

    const healthy = await runOnce(channelWith(new CollectingSink()));
    const broken = await runOnce(channelWith(new FailingSink()));

    // Coupling diagnostics health to accounting completeness in EITHER
    // direction is the bug.
    expect(broken.accounting).toEqual(healthy.accounting);
    expect(healthy.status.status).toBe('complete');
    expect(broken.status.status).toBe('unavailable');
  });
});
