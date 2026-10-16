import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AxlError,
  RequestCaptureChannel,
  agent,
  capturedJournalLineSchema,
  externalOperationRecordSchema,
  foldJournal,
  foldedOperationRecordSchema,
  modelCallRecordSchema,
  redactModelCallRecord,
  type CapturedRequestRecord,
  type SpanManager,
  workflow,
} from '../index.js';
import { scriptedRuntime } from './accounting-helpers.js';

function line(fields: Partial<CapturedRequestRecord> = {}): CapturedRequestRecord {
  return JSON.parse(
    JSON.stringify({
      v: 1,
      kind: 'chat',
      phase: 'start',
      operationId: 'one',
      provider: 'openai',
      model: 'openai:gpt',
      transportAttempts: 1,
      captured: {
        fidelity: 'runtime_request',
        redacted: false,
        truncated: false,
        continuityCaptured: true,
        omitted: [],
      },
      request: {
        messages: [{ role: 'user', content: 'secret' }],
        options: { model: 'openai:gpt' },
      },
      ...fields,
    }),
  ) as CapturedRequestRecord;
}

describe('public model-call record contract', () => {
  it('folds lines emitted by a current runtime capture channel', async () => {
    const { runtime } = scriptedRuntime([{ content: 'actual answer' }]);
    runtime.register(
      workflow({
        name: 'captured',
        input: z.any(),
        handler: (ctx) => ctx.ask(agent({ name: 'a', model: 'scripted:m' }), 'actual prompt'),
      }),
    );
    const lines: unknown[] = [];
    const channel = new RequestCaptureChannel({
      sink: {
        append: async (value) => {
          lines.push(JSON.parse(value));
        },
      },
    });
    await runtime.trackOutcome(() => runtime.execute('captured', {}), { capture: channel });
    await channel.close();
    const [record] = foldJournal(lines);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(modelCallRecordSchema.parse(record)).toMatchObject({
      kind: 'chat',
      purpose: 'ask',
      provider: 'scripted',
      model: 'm',
      outcome: { status: 'ok', response: { content: 'actual answer' } },
      captured: { replayable: true, continuityCaptured: true },
    });
  });

  it('reads untouched 0.25.3 journal lines without fabricating modern fields', () => {
    const path = new URL('./fixtures/model-call-record/axl-0253.jsonl', import.meta.url);
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((value) => JSON.parse(value) as unknown);
    const records = foldJournal(lines);
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.outcome.status)).toEqual([
      'ok',
      'error',
      'consumer_closed',
      'unfinished',
    ]);
    expect(records[0]).toMatchObject({
      model: 'fixture',
      usage: { total_tokens: 5 },
      cost: 0.00001,
      captured: { replayable: false },
    });
    for (const record of records) {
      expect(foldedOperationRecordSchema.safeParse(record).success).toBe(true);
      expect(record).not.toHaveProperty('startedAt');
      expect(record).not.toHaveProperty('endedAt');
      expect(record).not.toHaveProperty('purpose');
    }
    expect(records[2].outcome).toEqual({
      status: 'consumer_closed',
      termination: 'stream closed by the consumer',
    });
    expect(records[3].outcome).toEqual({ status: 'unfinished' });
  });

  it('folds interleaved turns, retries and a start-only call with observed values only', () => {
    const one = line({
      operationId: 'one',
      purpose: 'ask',
      askId: 'ask',
      turn: 1,
      startedAt: '2026-10-16T00:00:00.000Z',
    });
    const two = line({
      operationId: 'two',
      model: 'bare-model',
      request: undefined,
      captured: {
        fidelity: 'runtime_request',
        redacted: false,
        truncated: true,
        omitted: ['record'],
      },
    });
    const attempt = line({
      operationId: 'one',
      phase: 'attempt',
      request: undefined,
      transportAttempts: 2,
    });
    const end = line({
      operationId: 'one',
      phase: 'end',
      request: undefined,
      transportAttempts: 2,
      endedAt: '2026-10-16T00:00:01.000Z',
      durationMs: 1000,
      response: {
        content: 'answer',
        thinking: 'reason',
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        cost: 0.002,
        timing: { queuedMs: 1, attempts: 2, retryMs: 3, ttfbMs: 4, wireMs: 5 },
      },
    });
    const result = foldJournal([one, two, attempt, end]);
    expect(result).toHaveLength(2);
    expect(modelCallRecordSchema.parse(result[0])).toMatchObject({
      id: 'one',
      kind: 'chat',
      purpose: 'ask',
      startedAt: one.startedAt,
      endedAt: end.endedAt,
      ids: { askId: 'ask', turn: 1 },
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      cost: 0.002,
      timing: { attempts: 2, durationMs: 1000 },
      outcome: { status: 'ok', response: { content: 'answer', thinking: 'reason' } },
      captured: { replayable: true },
    });
    expect(result[1]).toMatchObject({
      model: 'bare-model',
      outcome: { status: 'unfinished' },
      captured: { replayable: false },
    });
    expect(result[1]).not.toHaveProperty('request');
    expect(result[1]).not.toHaveProperty('startedAt');
    expect(result[1]).not.toHaveProperty('purpose');
  });

  it('retains known successful and failed stub outcomes without a fabricated payload', () => {
    const start = line({ retryReason: 'schema', rejectedCallId: 'prior' });
    const ok = line({
      phase: 'end',
      request: undefined,
      response: undefined,
      outcomeStatus: 'ok',
      finishReason: 'length',
      responseId: 'r1',
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      captured: {
        fidelity: 'runtime_request',
        redacted: false,
        truncated: true,
        omitted: ['record'],
      },
    });
    const success = foldJournal([start, ok])[0];
    expect(success.outcome).toEqual({
      status: 'ok',
      payloadOmitted: true,
      finishReason: 'length',
      responseId: 'r1',
    });
    expect(success.captured.replayable).toBe(false);
    expect(success.gate).toEqual({ retryReason: 'schema', rejectedCallId: 'prior' });
    const failed = foldJournal([
      start,
      JSON.parse(
        JSON.stringify({
          ...ok,
          outcomeStatus: 'error',
          finishReason: undefined,
          responseId: undefined,
          error: { message: '[truncated]', status: 429 },
        }),
      ),
    ])[0];
    expect(failed.outcome).toEqual({
      status: 'error',
      payloadOmitted: true,
      error: { message: '[truncated]', status: 429 },
    });
    const endOnly = foldJournal([
      line({ phase: 'end', request: undefined, response: { content: 'known' } }),
    ])[0];
    expect(endOnly.outcome.status).toBe('ok');
    expect(endOnly.captured.replayable).toBe(false);
    expect(endOnly).not.toHaveProperty('request');
  });

  it('preserves external operations and refuses to validate them as model calls', () => {
    const start = {
      v: 1,
      kind: 'external',
      phase: 'start',
      operationId: 'e',
      name: 'vendor',
      transportAttempts: 1,
      captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
    } as const;
    const end = {
      ...start,
      phase: 'end',
      outcomeStatus: 'ok',
      external: { request: { query: 'secret' }, response: ['private'] },
      cost: 0.01,
      usage: { inputTokens: 2 },
    } as const;
    const result = foldJournal([start, end])[0];
    expect(externalOperationRecordSchema.parse(result)).toMatchObject({
      kind: 'external',
      name: 'vendor',
      cost: 0.01,
      outcome: { status: 'ok' },
    });
    expect(modelCallRecordSchema.safeParse(result).success).toBe(false);
  });

  it('deduplicates exact lines and rejects contradictory or malformed input with AxlError', () => {
    const start = line();
    const end = line({ phase: 'end', request: undefined, response: { content: 'done' } });
    expect(foldJournal([start, start, end])).toHaveLength(1);
    for (const input of [
      [{ ...start, v: 2 }],
      [start, { ...start, provider: 'anthropic', phase: 'end' }],
      [
        start,
        {
          ...start,
          request: { ...start.request, messages: [{ role: 'user', content: 'changed' }] },
        },
      ],
      [start, end, { ...end, response: { content: 'changed' } }],
      [start, { ...end, response: { content: 'done', providerMetadata: { bad: undefined } } }],
      [start, { ...end, response: undefined, termination: 'unrecognized terminal' }],
      [{ ...start, phase: 'attempt', request: start.request }],
      [{ ...end, phase: 'start', response: end.response }],
    ])
      expect(() => foldJournal(input)).toThrow(AxlError);
    expect(
      capturedJournalLineSchema.safeParse({
        ...start,
        request: {
          ...start.request,
          messages: [{ role: 'user', content: 'x', providerMetadata: { bad: () => 1 } }],
        },
      }).success,
    ).toBe(false);
    expect(
      capturedJournalLineSchema.safeParse({
        ...start,
        request: {
          ...start.request,
          messages: [{ role: 'user', content: 'x', providerMetadata: { bad: new Date() } }],
        },
      }).success,
    ).toBe(false);
  });

  it('validates replayable claims and redacts all content in a pure copy', () => {
    const start = line({
      retryReason: 'schema',
      rejectedCallId: 'previous',
      correction: {
        stage: 'schema',
        reason: 'secret reason',
        feedbackMessage: 'secret correction',
      },
      request: {
        messages: [
          {
            role: 'assistant',
            content: 'prompt',
            providerMetadata: { sig: 'secret' },
            tool_calls: [
              {
                id: 't',
                type: 'function',
                function: { name: 'tool', arguments: '{"key":"secret"}' },
              },
            ],
          },
        ],
        tools: [{ name: 'tool', parameters: { private: 'schema' } }],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'output', schema: { private: true } },
        },
        options: { model: 'openai:gpt', toolChoice: { private: 'value' } },
      },
    });
    const end = line({
      phase: 'end',
      request: undefined,
      response: {
        content: 'answer',
        thinking: 'thought',
        providerMetadata: { secret: 'metadata' },
        tool_calls: [
          { id: 't', type: 'function', function: { name: 'tool', arguments: 'secret args' } },
        ],
      },
    });
    const original = foldJournal([start, end])[0];
    const redacted = redactModelCallRecord(original);
    expect(JSON.stringify(redacted)).not.toMatch(/secret|thought|prompt|answer|private/);
    expect(JSON.stringify(original)).toContain('secret');
    expect(redacted).toMatchObject({
      gate: { rejectedCallId: 'previous', correction: { feedbackMessage: '[redacted]' } },
      captured: { redacted: true, replayable: false, omitted: ['providerMetadata'] },
    });
    expect(foldedOperationRecordSchema.safeParse(redacted).success).toBe(true);
    expect(
      modelCallRecordSchema.safeParse({
        ...original,
        captured: { ...original.captured, redacted: true, replayable: true },
      }).success,
    ).toBe(false);
    const external = foldJournal([
      {
        v: 1,
        kind: 'external',
        phase: 'start',
        operationId: 'e',
        name: 'vendor',
        transportAttempts: 1,
        captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
      },
      {
        v: 1,
        kind: 'external',
        phase: 'end',
        operationId: 'e',
        name: 'vendor',
        transportAttempts: 1,
        external: { request: { secret: true } },
        outcomeStatus: 'ok',
        captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
      },
    ])[0];
    expect(JSON.stringify(redactModelCallRecord(external))).not.toContain('secret');
  });

  it('keeps a legacy SpanManager implementation assignable', () => {
    const manager: SpanManager = {
      withSpanAsync: async (_name, _attrs, fn) =>
        fn({ setAttribute() {}, addEvent() {}, setStatus() {}, end() {} }),
      addEventToActiveSpan() {},
      shutdown: async () => {},
    };
    expect(manager.startSpan).toBeUndefined();
  });
});
