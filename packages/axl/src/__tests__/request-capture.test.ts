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
import { AdmissionController } from '../accounting.js';
import { ProviderError } from '../providers/errors.js';
import { StallTimeoutError } from '../errors.js';
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
    expect(starts[1].rejectedCallId).toBe(starts[0].operationId);
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
    expect(starts[1].rejectedCallId).toBe(starts[0].operationId);
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
    expect(starts[1].rejectedCallId).toBe(starts[0].operationId);
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
    expect(starts[1].rejectedCallId).toBeUndefined();
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

describe('P2 — journal fidelity at the provider boundary', () => {
  it('labels runtime summaries and eval judge calls without inventing ask identity', async () => {
    const { runtime } = scriptedRuntime([{ content: 'summary' }, { content: 'judge' }]);
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(
      async () => {
        await runtime.summarizeMessages([{ role: 'user', content: 'old history' }], 'scripted:m');
        await runtime.trackOutcome(
          () =>
            runtime
              .resolveProvider('scripted:m')
              .provider.chat([{ role: 'user', content: 'score this' }], { model: 'm' }),
          { purpose: 'judging', captureCorrelation: { caseIndex: 2, scorer: 'quality' } },
        );
      },
      { capture: channel },
    );
    await channel.close();
    expect(outcome.status).toBe('fulfilled');
    const starts = phase(sink.records(), 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ purpose: 'summary', turn: 0 });
    expect(starts[0].askId).toBeUndefined();
    expect(starts[1]).toMatchObject({ purpose: 'judge', caseIndex: 2, scorer: 'quality' });
    expect(starts[1].askId).toBeUndefined();
    expect(starts[1].turn).toBeUndefined();
  });

  it('keeps a context summary in its nested ask branch without inheriting repair state', async () => {
    const { runtime } = scriptedRuntime([
      {
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'nested', arguments: '{}' } }],
      },
      { content: 'summary' },
      { content: 'inner answer' },
      { content: 'outer answer' },
    ]);
    const { tool } = await import('../tool.js');
    const inner = agent({ name: 'inner', model: 'scripted:m', maxContext: 500 });
    let ctx!: ReturnType<typeof runtime.createContext>;
    const nested = tool({
      name: 'nested',
      description: 'nested ask',
      input: z.object({}),
      handler: async () => ctx.ask(inner, 'inner'),
    } as never);
    const outer = agent({ name: 'outer', model: 'scripted:m', tools: [nested] });
    ctx = runtime.createContext({
      sessionHistory: Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
        content: `history ${i} ${'x'.repeat(200)}`,
      })),
    });
    const { records } = await capture(runtime, () => ctx.ask(outer, 'outer'));
    const starts = phase(records, 'start');
    const summary = starts.find((r) => r.purpose === 'summary')!;
    const nestedAsk = starts.find((r) => r.purpose === 'ask' && r.agent === 'inner')!;
    const outerAsk = starts.find((r) => r.purpose === 'ask' && r.agent === 'outer')!;
    expect(summary).toBeDefined();
    expect(nestedAsk).toBeDefined();
    expect(summary.askId).toBe(nestedAsk.askId);
    expect(summary.parentAskId).toBe(outerAsk.askId);
    expect(nestedAsk.parentAskId).toBe(outerAsk.askId);
    expect(summary).toMatchObject({ purpose: 'summary', turn: 0 });
    expect(summary.retryReason).toBeUndefined();
    expect(summary.rejectedCallId).toBeUndefined();
    expect(summary.correction).toBeUndefined();
  });

  it('links repair calls within concurrent ask branches only', async () => {
    const attempts = new Map<string, number>();
    const provider: Provider = {
      name: 'branch',
      async chat(messages) {
        const branch = messages.some(
          (message) => typeof message.content === 'string' && message.content.includes('branch-A'),
        )
          ? 'A'
          : 'B';
        const attempt = (attempts.get(branch) ?? 0) + 1;
        attempts.set(branch, attempt);
        await Promise.resolve(); // Both asks can be in flight before either settles.
        return { content: attempt === 1 ? 'invalid' : '{"value":1}' };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'branch' });
    runtime.registerProvider('branch', provider);
    const asker = agent({ name: 'branch-agent', model: 'branch:m', system: 'fixture' });
    runtime.register(
      workflow({
        name: 'parallel-repairs',
        input: z.any(),
        handler: async (ctx) =>
          Promise.all([
            ctx.ask(asker, 'branch-A', { schema: Answer, retries: 1 }),
            ctx.ask(asker, 'branch-B', { schema: Answer, retries: 1 }),
          ]),
      }),
    );
    const { records, outcome } = await capture(runtime, () =>
      runtime.execute('parallel-repairs', {}),
    );
    expect(outcome.status).toBe('fulfilled');
    const byAsk = new Map<string, CapturedRequestRecord[]>();
    for (const record of phase(records, 'start')) {
      const key = record.askId ?? 'missing';
      byAsk.set(key, [...(byAsk.get(key) ?? []), record]);
    }
    expect(byAsk.size).toBe(2);
    for (const starts of byAsk.values()) {
      expect(starts).toHaveLength(2);
      expect(starts![1].rejectedCallId).toBe(starts![0].operationId);
      expect(starts![1].retryReason).toBe('schema');
      expect(starts![0].workflow).toBe('parallel-repairs');
      expect(starts![0].agent).toBe('branch-agent');
      expect(starts![0].depth).toBe(0);
      expect(starts![0].purpose).toBe('ask');
    }
  });

  it('emits no journal lines when admission closes after open but before built-in dispatch', async () => {
    const entered = deferred();
    const release = deferred();
    class AdmissionAwareProvider implements Provider {
      readonly name = 'admission-aware';
      readonly reportsRequestLifecycle = true as const;
      async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
        if (messages[0]?.content === 'slow') {
          entered.resolve();
          await release.promise;
        }
        options.dispatchAdmission?.beforeDispatch(1);
        options.requestLifecycle?.onDispatch?.();
        return { content: 'ok', cost: 1 };
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      }
    }
    const runtime = new AxlRuntime({ defaultProvider: 'admission-aware' });
    runtime.registerProvider('admission-aware', new AdmissionAwareProvider());
    const facade = runtime.resolveProvider('admission-aware:m').provider;
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const admission = new AdmissionController({ limit: 1 });
    const outcome = await runtime.trackOutcome(
      async () => {
        const slow = facade.chat([{ role: 'user', content: 'slow' }], { model: 'm' });
        await entered.promise;
        await facade.chat([{ role: 'user', content: 'fast' }], { model: 'm' });
        release.resolve();
        await expect(slow).rejects.toMatchObject({ name: 'AdmissionDeniedError' });
      },
      { admission, capture: channel },
    );
    await channel.close();

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.operations.denied).toBe(1);
    expect(sink.records().map((record) => record.phase)).toEqual(['start', 'end']);
    expect(phase(sink.records(), 'start')[0].request?.messages[0].content).toBe('fast');
  });

  it('snapshots nested continuity metadata, tool schemas and response metadata by value', async () => {
    const continuity = {
      anthropicThinkingBlocks: [
        { type: 'thinking', thinking: 'reason', signature: 'sig-original' },
      ],
    };
    const parameters = { type: 'object', properties: { city: { description: 'original' } } };
    const responseMetadata = { geminiParts: [{ text: 'raw', thoughtSignature: 'sig-response' }] };
    const provider: Provider = {
      name: 'fixture',
      async chat() {
        return {
          content: 'answer',
          thinking_content: 'hidden reasoning',
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
          responseId: 'msg_1',
          responseModel: 'served-model',
          providerMetadata: responseMetadata,
        };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'fixture' });
    runtime.registerProvider('fixture', provider);
    const facade = runtime.resolveProvider('fixture:m').provider;
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'prior', providerMetadata: continuity },
    ];
    const tools = [{ type: 'function' as const, function: { name: 'lookup', parameters } }];

    await runtime.trackOutcome(() => facade.chat(messages, { model: 'm', tools }), {
      capture: channel,
    });
    continuity.anthropicThinkingBlocks[0].signature = 'mutated';
    parameters.properties.city.description = 'mutated';
    responseMetadata.geminiParts[0].thoughtSignature = 'mutated';
    await channel.close();

    const start = phase(sink.records(), 'start')[0];
    const end = phase(sink.records(), 'end')[0];
    expect(start.captured.continuityCaptured).toBe(true);
    expect(start.request?.messages[0].providerMetadata).toEqual({
      anthropicThinkingBlocks: [
        { type: 'thinking', thinking: 'reason', signature: 'sig-original' },
      ],
    });
    expect(start.request?.tools?.[0].parameters).toMatchObject({
      properties: { city: { description: 'original' } },
    });
    expect(end.response).toMatchObject({
      content: 'answer',
      thinking: 'hidden reasoning',
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseId: 'msg_1',
      responseModel: 'served-model',
      providerMetadata: { geminiParts: [{ thoughtSignature: 'sig-response' }] },
    });
    expect(start.startedAt).toMatch(/^\d{4}-/);
    expect(end.endedAt).toMatch(/^\d{4}-/);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retains streamed text, thinking, tool calls and terminal metadata', async () => {
    const provider: Provider = {
      name: 'stream-fixture',
      async chat() {
        return { content: 'unused' };
      },
      async *stream() {
        yield { type: 'text_delta', content: 'first ' };
        yield { type: 'thinking_delta', content: 'plan' };
        yield { type: 'tool_call_delta', id: 'call_1', name: 'lookup', arguments: '{"q":' };
        yield { type: 'text_delta', content: 'second' };
        yield { type: 'tool_call_delta', id: 'call_1', arguments: '"x"}' };
        yield {
          type: 'done',
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_use',
          responseId: 'stream_1',
          responseModel: 'served-model',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          timing: { queuedMs: 0, attempts: 1, retryMs: 0, ttfbMs: 1, wireMs: 2 },
        };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'stream-fixture' });
    runtime.registerProvider('stream-fixture', provider);
    const facade = runtime.resolveProvider('stream-fixture:m').provider;
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      async () => {
        for await (const _chunk of facade.stream([], { model: 'm' })) void _chunk;
      },
      { capture: channel },
    );
    await channel.close();

    const end = phase(sink.records(), 'end')[0];
    expect(end.response).toMatchObject({
      content: 'first second',
      thinking: 'plan',
      tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_use',
      responseId: 'stream_1',
      responseModel: 'served-model',
      usage: { total_tokens: 5 },
      timing: { wireMs: 2 },
    });
  });

  it('records partial output and consumer_closed on an early break', async () => {
    const provider: Provider = {
      name: 'partial',
      async chat() {
        return { content: 'unused' };
      },
      async *stream() {
        yield { type: 'text_delta', content: 'visible' };
        yield { type: 'thinking_delta', content: 'private' };
        yield { type: 'text_delta', content: 'unseen' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'partial' });
    runtime.registerProvider('partial', provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const facade = runtime.resolveProvider('partial:m').provider;
    await runtime.trackOutcome(
      async () => {
        for await (const chunk of facade.stream([], { model: 'm' })) {
          if (chunk.type === 'thinking_delta') break;
        }
      },
      { capture: channel },
    );
    await channel.close();
    const end = phase(sink.records(), 'end')[0];
    expect(end.termination).toBe('consumer_closed');
    expect(end.partial).toEqual({ content: 'visible', thinking: 'private' });
    expect(end.response).toBeUndefined();
  });

  it('records partial output and aborted on a real abort signal', async () => {
    const controller = new AbortController();
    const provider: Provider = {
      name: 'abortable',
      async chat() {
        return { content: 'unused' };
      },
      async *stream(_messages, options) {
        yield { type: 'text_delta', content: 'partial' };
        options.signal?.throwIfAborted();
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'abortable' });
    runtime.registerProvider('abortable', provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const facade = runtime.resolveProvider('abortable:m').provider;
    await runtime.trackOutcome(
      async () => {
        const iterator = facade.stream([], { model: 'm', signal: controller.signal });
        expect((await iterator.next()).value).toMatchObject({ type: 'text_delta' });
        controller.abort(new DOMException('cancelled', 'AbortError'));
        await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      },
      { capture: channel },
    );
    await channel.close();
    const end = phase(sink.records(), 'end')[0];
    expect(end.termination).toBe('aborted');
    expect(end.partial).toEqual({ content: 'partial' });
    expect(end.response).toBeUndefined();
  });

  it('records partial output and stalled on a real context stall timeout', async () => {
    const provider: Provider = {
      name: 'staller',
      async chat() {
        return { content: 'unused' };
      },
      async *stream(_messages, options) {
        yield { type: 'text_delta', content: 'partial' };
        await new Promise<never>((_resolve, reject) => {
          const signal = options.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'staller' });
    runtime.registerProvider('staller', provider);
    const asker = agent({ name: 'staller', model: 'staller:m', system: 'fixture' });
    runtime.register(
      workflow({
        name: 'stalled-workflow',
        input: z.any(),
        handler: async (ctx) => {
          void ctx.events; // Real provider streaming path.
          return ctx.ask(asker, 'go', { stallTimeout: '20ms' });
        },
      }),
    );
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(() => runtime.execute('stalled-workflow', {}), {
      capture: channel,
    });
    await channel.close();
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBeInstanceOf(StallTimeoutError);
    const end = phase(sink.records(), 'end')[0];
    expect(end.termination).toBe('stalled');
    expect(end.partial).toEqual({ content: 'partial' });
    expect(end.response).toBeUndefined();
  });

  it('projects ProviderError retry hints and request id without its raw body', async () => {
    const provider: Provider = {
      name: 'error-fixture',
      async chat() {
        throw new ProviderError({
          provider: 'error-fixture',
          status: 429,
          retryable: true,
          requestId: 'req_123',
          retryAfterMs: 250,
          message: 'throttled',
          body: 'secret raw body',
        });
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'error-fixture' });
    runtime.registerProvider('error-fixture', provider);
    const facade = runtime.resolveProvider('error-fixture:m').provider;
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(() => facade.chat([], { model: 'm' }), { capture: channel });
    await channel.close();
    expect(phase(sink.records(), 'end')[0].error).toMatchObject({
      name: 'ProviderError',
      code: 'PROVIDER_ERROR',
      status: 429,
      retryable: true,
      requestId: 'req_123',
      retryAfterMs: 250,
    });
    expect(JSON.stringify(sink.records())).not.toContain('secret raw body');
  });

  it('redacts continuity metadata, thinking and tool arguments while retaining structure', async () => {
    const secret = 'SECRET-CONTINUITY-4242';
    const provider: Provider = {
      name: 'redacted',
      async chat() {
        return {
          content: secret,
          thinking_content: secret,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: secret } },
          ],
          providerMetadata: { geminiParts: [{ thoughtSignature: secret }] },
          responseId: 'resp_1',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          cost: 0.01,
        };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'redacted' });
    runtime.registerProvider('redacted', provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink, { redact: true });
    await runtime.trackOutcome(
      () =>
        runtime.resolveProvider('redacted:m').provider.chat(
          [
            {
              role: 'assistant',
              content: secret,
              providerMetadata: { anthropicThinkingBlocks: [{ signature: secret }] },
              tool_calls: [
                { id: 'prior', type: 'function', function: { name: 'lookup', arguments: secret } },
              ],
            },
          ],
          { model: 'm' },
        ),
      { capture: channel },
    );
    await channel.close();
    expect(sink.lines.join('\n')).not.toContain(secret);
    const start = phase(sink.records(), 'start')[0];
    const end = phase(sink.records(), 'end')[0];
    expect(start.request?.messages[0]).not.toHaveProperty('providerMetadata');
    expect(end.response).not.toHaveProperty('providerMetadata');
    expect(start.captured.omitted).toContain('providerMetadata');
    expect(end.captured.omitted).toContain('providerMetadata');
    expect(end.response).toMatchObject({
      responseId: 'resp_1',
      usage: { total_tokens: 3 },
      cost: 0.01,
    });
  });

  it('redacts partial stream output and provider error payload', async () => {
    const secret = 'SECRET-PARTIAL-4242';
    const provider: Provider = {
      name: 'redacted-stream',
      async chat() {
        return { content: 'unused' };
      },
      async *stream() {
        yield { type: 'text_delta', content: secret };
        yield { type: 'thinking_delta', content: secret };
        yield { type: 'tool_call_delta', id: 'call_1', name: 'lookup', arguments: secret };
        throw new ProviderError({
          provider: 'redacted-stream',
          status: 429,
          retryable: true,
          requestId: 'req_1',
          message: secret,
          body: secret,
        });
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'redacted-stream' });
    runtime.registerProvider('redacted-stream', provider);
    const facade = runtime.resolveProvider('redacted-stream:m').provider;
    const sink = new CollectingSink();
    const channel = channelWith(sink, { redact: true });
    await runtime.trackOutcome(
      async () => {
        await expect(async () => {
          for await (const _chunk of facade.stream([], { model: 'm' })) void _chunk;
        }).rejects.toBeInstanceOf(ProviderError);
      },
      { capture: channel },
    );
    await channel.close();
    expect(sink.lines.join('\n')).not.toContain(secret);
    const end = phase(sink.records(), 'end')[0];
    expect(end.partial).toMatchObject({ content: '[redacted]', thinking: '[redacted]' });
    expect(end.error).toMatchObject({ status: 429, retryable: true, requestId: 'req_1' });
  });

  it('keeps settlement evidence when an oversized end response is stubbed', async () => {
    const provider: Provider = {
      name: 'oversized',
      async chat() {
        return {
          content: 'x'.repeat(2_000),
          cost: 0.25,
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          finishReason: 'length',
          rawFinishReason: 'max_tokens',
          responseId: 'resp_large',
          responseModel: 'served-model',
          timing: { queuedMs: 0, attempts: 1, retryMs: 0, ttfbMs: 1, wireMs: 2 },
        } as ProviderResponse;
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'oversized' });
    runtime.registerProvider('oversized', provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink, { maxRecordBytes: 1_024 });
    await runtime.trackOutcome(
      () => runtime.resolveProvider('oversized:m').provider.chat([], { model: 'm' }),
      { capture: channel },
    );
    await channel.close();
    const end = phase(sink.records(), 'end')[0];
    expect(end.response).toBeUndefined();
    expect(end).toMatchObject({
      outcomeStatus: 'ok',
      cost: 0.25,
      usage: { total_tokens: 5 },
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      responseId: 'resp_large',
      responseModel: 'served-model',
      timing: { wireMs: 2 },
      captured: { truncated: true },
    });
    expect(end.captured.omitted).toContain('record');
    expect(sink.lines.every((line) => Buffer.byteLength(line, 'utf-8') <= 1_024)).toBe(true);
    expect(channel.operations()[0].status).toBe('truncated');
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
    expect(channel.operations()).toMatchObject([
      { operationId: start.operationId, status: 'truncated' },
    ]);
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

// ── Capture failure is contained (adversarial review H1, M4) ─────────

/**
 * The frozen guarantee is that accounting is byte-identical with capture on,
 * off, truncated or failing. `RequestCaptureChannel.write()` was already total;
 * these pin the rest of the path, where a projection failure sits between an
 * OPENED accounting operation and the provider call.
 *
 * Both inputs below are inside the public contract: `ResponseFormat.json_schema.schema`
 * is typed `unknown`, and a content part's `type` is not validated before it
 * reaches an adapter.
 */
describe('capture failures never reach the run', () => {
  /** A provider that answers, and remembers exactly what it was asked. */
  function recordingProvider(): Provider & { calls: ChatOptions[] } {
    const calls: ChatOptions[] = [];
    return {
      name: 'scripted',
      calls,
      async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
        calls.push(options);
        return {
          content: 'answer',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          cost: 0.25,
        };
      },
    } as Provider & { calls: ChatOptions[] };
  }

  function providerRuntime(): {
    runtime: AxlRuntime;
    provider: Provider & { calls: ChatOptions[] };
  } {
    const provider = recordingProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', trace: { enabled: false } });
    runtime.registerProvider('scripted', provider);
    return { runtime, provider };
  }

  /** Ask once through the facade, with whatever hostile options the test supplies. */
  async function ask(
    runtime: AxlRuntime,
    options: Partial<ChatOptions>,
  ): Promise<ProviderResponse> {
    const { provider } = runtime.resolveProvider('scripted:m');
    return provider.chat([{ role: 'user', content: 'go' }], {
      model: 'scripted:m',
      ...options,
    } as ChatOptions);
  }

  it('a non-cloneable responseFormat schema does not fail the call or move the numbers', async () => {
    // A schema object carrying a function: `structuredClone` raises DataCloneError.
    const hostile = {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { validate() {} } },
    } as unknown as ChatOptions['responseFormat'];

    const off = providerRuntime();
    const baseline = await off.runtime.trackOutcome(() =>
      ask(off.runtime, { responseFormat: hostile }),
    );

    const on = providerRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await on.runtime.trackOutcome(
      () => ask(on.runtime, { responseFormat: hostile }),
      {
        capture: channel,
      },
    );
    const status = await channel.close();

    // The provider was called and its answer was returned, unchanged.
    expect(outcome.status).toBe('fulfilled');
    expect((outcome as { value: ProviderResponse }).value.content).toBe('answer');
    expect(on.provider.calls).toHaveLength(1);
    // And the numbers are the same as the capture-off run, to the byte.
    expect(outcome.accounting).toEqual(baseline.accounting);
    // The loss is reported on the diagnostics rail, where it belongs — as ONE
    // stubbed record. Losing the whole run's capture over one un-projectable
    // call is the N6 failure: an eval where one case in 200 carries an odd
    // schema would surrender the other 199 cases of evidence.
    expect(status.status).toBe('complete');
    const stub = sink.records()[0];
    expect(stub.captured.truncated).toBe(true);
    expect(stub.captured.omitted).toContain('record');
    expect(stub.captured.reason).toBeTruthy();
    // The operation is still NAMED: one missing from the artifact reads as a
    // call that was never made.
    expect(stub.operationId).toBeTruthy();
    expect(channel.operations()[0].status).toBe('omitted');
    // The reason names the DEFECT, never the value that caused it. A
    // DataCloneError's message stringifies the thing it choked on — here the
    // schema's `validate` function, elsewhere a prompt — and this record goes
    // straight to the sink without passing through `redactCapturedRequest`,
    // so a message would land in the artifact stamped `redacted: true`.
    expect(stub.captured.reason).not.toMatch(/validate/);
    expect(stub.captured.reason).toMatch(/DataCloneError/);
  });

  it('a mutable options getter cannot rewrite or break a later retry record', async () => {
    // The model is snapshotted before provider invocation. Reading a hostile
    // getter again on retry would let provider-side mutation corrupt capture.
    let hostile = false;
    const options = {
      get model(): string {
        if (hostile) {
          hostile = false;
          throw new Error('the model could not be read');
        }
        return 'm';
      },
    } as unknown as ChatOptions;

    class RetryingProvider implements Provider {
      readonly name = 'retry';
      readonly reportsRequestLifecycle = true as const;
      async chat(_messages: ChatMessage[], opts: ChatOptions): Promise<ProviderResponse> {
        opts.requestLifecycle?.onDispatch?.();
        opts.requestLifecycle?.onRetry?.();
        hostile = true;
        opts.requestLifecycle?.onDispatch?.();
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
    const outcome = await runtime.trackOutcome(
      () => facade.chat([{ role: 'user', content: 'hi' }], options),
      { capture: channel },
    );
    const status = await channel.close();

    expect(outcome.status).toBe('fulfilled');
    expect(status.status).toBe('complete');
    // The retry retains the original request identity without re-reading the
    // caller's mutable options.
    const attempt = phase(sink.records(), 'attempt')[0];
    expect(attempt.captured.truncated).toBe(false);
    expect(attempt.model).toBe('m');
    // And the RESPONSE still lands. A retry record nobody could project says
    // nothing about the response that follows: the call ran and returned. Only
    // `end()` seals an operation, so a failed attempt must not stand in for it —
    // an operation with no `end` is the shape that means "never came back".
    const end = phase(sink.records(), 'end');
    expect(end).toHaveLength(1);
    expect(end[0].response).toBeDefined();
    expect(channel.operations()[0].status).toBe('recorded');
  });

  it('keeps capturing the rest of the run after one un-projectable call', async () => {
    const hostile = {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { validate() {} } },
    } as unknown as ChatOptions['responseFormat'];

    const on = providerRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await on.runtime.trackOutcome(
      async () => {
        await ask(on.runtime, { responseFormat: hostile });
        await ask(on.runtime, {});
      },
      { capture: channel },
    );
    const status = await channel.close();

    expect(status.status).toBe('complete');
    // The second call is fully recorded: request in, response out.
    const starts = phase(sink.records(), 'start');
    const usable = starts.filter((r) => r.request !== undefined);
    expect(usable).toHaveLength(1);
    // A request-projection stub is incomplete evidence, but the dispatched
    // call's actual successful settlement is still an end line with usage.
    const ends = phase(sink.records(), 'end');
    expect(ends).toHaveLength(2);
    const stub = starts.find((r) => r.captured.truncated)!;
    expect(ends.find((r) => r.operationId === stub.operationId)?.response).toBeDefined();
    expect(channel.operations().find((r) => r.operationId === stub.operationId)?.status).toBe(
      'omitted',
    );
  });

  it('an unrecognized content part does not fail the call or move the numbers', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'video', url: 'x' }] },
    ] as unknown as ChatMessage[];

    const off = providerRuntime();
    const baseline = await off.runtime.trackOutcome(() =>
      off.runtime.resolveProvider('scripted:m').provider.chat(messages, { model: 'scripted:m' }),
    );

    const on = providerRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await on.runtime.trackOutcome(
      () =>
        on.runtime.resolveProvider('scripted:m').provider.chat(messages, { model: 'scripted:m' }),
      { capture: channel },
    );
    const status = await channel.close();

    expect(outcome.status).toBe('fulfilled');
    expect(on.provider.calls).toHaveLength(1);
    expect(outcome.accounting).toEqual(baseline.accounting);
    // One stubbed record, not a silenced run.
    expect(status.status).toBe('complete');
    expect(sink.records()[0].captured.reason).toBeTruthy();
  });

  it('a projection failure on the RESPONSE does not turn a success into a failure', async () => {
    // A response whose `timing` getter throws — snapshotResponse touches it.
    const provider = {
      name: 'scripted',
      async chat(): Promise<ProviderResponse> {
        const response = { content: 'answer', cost: 0.1 } as ProviderResponse;
        Object.defineProperty(response, 'timing', {
          get() {
            throw new Error('hostile getter');
          },
          enumerable: true,
        });
        return response;
      },
    } as Provider;
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', trace: { enabled: false } });
    runtime.registerProvider('scripted', provider);

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(
      () =>
        runtime.resolveProvider('scripted:m').provider.chat([{ role: 'user', content: 'go' }], {
          model: 'scripted:m',
        }),
      { capture: channel },
    );
    await channel.close();

    // Converting a paid, successful provider response into a run failure is the
    // bug: the charge is real either way.
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBeCloseTo(0.1, 10);
  });

  it('a hostile stream delta cannot change the returned chunks or masquerade as complete capture', async () => {
    const bad = { type: 'tool_call_delta', id: 'tool-1', name: 'search' } as StreamChunk;
    Object.defineProperty(bad, 'arguments', {
      get() {
        throw new Error('secret model output');
      },
    });
    const provider = {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield bad;
        yield { type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
    } as Provider;
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', trace: { enabled: false } });
    runtime.registerProvider('scripted', provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(
      async () => {
        const chunks: StreamChunk[] = [];
        for await (const chunk of runtime.resolveProvider('scripted:m').provider.stream!(
          [{ role: 'user', content: 'go' }],
          { model: 'scripted:m' },
        ))
          chunks.push(chunk);
        return chunks;
      },
      { capture: channel },
    );
    await channel.close();
    expect(outcome.status).toBe('fulfilled');
    expect(Object.is(outcome.status === 'fulfilled' ? outcome.value[0] : undefined, bad)).toBe(
      true,
    );
    expect(outcome.accounting.usage.inputTokens).toBe(1);
    const end = phase(sink.records(), 'end')[0];
    expect(end.captured.omitted).toContain('streamChunk');
    expect(JSON.stringify(sink.records())).not.toContain('secret model output');
  });

  it('a terminal metadata projection failure records successful settlement without changing the done chunk', async () => {
    const done = { type: 'done', cost: 0.03 } as StreamChunk;
    Object.defineProperty(done, 'providerMetadata', {
      get() {
        throw new Error('secret native response');
      },
    });
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', trace: { enabled: false } });
    runtime.registerProvider('scripted', {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield done;
      },
    } as Provider);
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(
      async () => {
        const seen: StreamChunk[] = [];
        for await (const chunk of runtime.resolveProvider('scripted:m').provider.stream!(
          [{ role: 'user', content: 'go' }],
          { model: 'scripted:m' },
        ))
          seen.push(chunk);
        return seen;
      },
      { capture: channel },
    );
    await channel.close();
    expect(outcome.status).toBe('fulfilled');
    expect(Object.is(outcome.status === 'fulfilled' ? outcome.value[0] : undefined, done)).toBe(
      true,
    );
    expect(outcome.accounting.knownCost).toBeCloseTo(0.03, 10);
    const end = phase(sink.records(), 'end')[0];
    expect(end).toMatchObject({
      outcomeStatus: 'ok',
      captured: { truncated: true, omitted: ['record'] },
    });
    expect(end.endedAt).toBeDefined();
    expect(JSON.stringify(sink.records())).not.toContain('secret native response');
  });

  it('M4 a stream closed early is sealed with a termination reason, not left start_only', async () => {
    const provider = {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'token', content: 'a' } as StreamChunk;
        yield { type: 'token', content: 'b' } as StreamChunk;
        // Never reaches a `done` chunk: the consumer breaks first.
        yield { type: 'token', content: 'c' } as StreamChunk;
      },
    } as unknown as Provider;
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', trace: { enabled: false } });
    runtime.registerProvider('scripted', provider);

    const sink = new CollectingSink();
    const channel = channelWith(sink);
    await runtime.trackOutcome(
      async () => {
        const iterator = runtime.resolveProvider('scripted:m').provider.stream!(
          [{ role: 'user', content: 'go' }],
          { model: 'scripted:m' },
        );
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const chunk of iterator) break; // stall-timeout / caller break
      },
      { capture: channel },
    );
    await channel.close();

    const records = sink.records();
    const ends = phase(records, 'end');
    // Without an end record the ref stays `start_only` — the label reserved for
    // a call that never came back, which makes a deliberate close and a hung
    // call indistinguishable to whoever is triaging stalls.
    expect(ends).toHaveLength(1);
    expect(ends[0].termination).toBeTruthy();
    expect(channel.operations()[0].status).toBe('recorded');
  });
});
