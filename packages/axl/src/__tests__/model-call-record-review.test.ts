import { describe, expect, it } from 'vitest';
import {
  AxlError,
  capturedJournalLineSchema,
  externalOperationRecordSchema,
  foldJournal,
  modelCallRecordSchema,
  redactCapturedRequest,
  redactModelCallRecord,
  type CapturedRequestRecord,
} from '../index.js';

const captured = {
  fidelity: 'runtime_request',
  redacted: false,
  truncated: false,
  continuityCaptured: true,
  omitted: [],
} as const;
function start(extra: Record<string, unknown> = {}): CapturedRequestRecord {
  return {
    v: 1,
    kind: 'chat',
    phase: 'start',
    operationId: 'call',
    provider: 'p',
    model: 'm',
    transportAttempts: 1,
    captured: { ...captured, omitted: [] },
    request: { messages: [{ role: 'user', content: 'request' }], options: { model: 'm' } },
    ...extra,
  } as CapturedRequestRecord;
}
function end(extra: Record<string, unknown> = {}): CapturedRequestRecord {
  return {
    v: 1,
    kind: 'chat',
    phase: 'end',
    operationId: 'call',
    provider: 'p',
    model: 'm',
    transportAttempts: 1,
    captured: { ...captured, omitted: [] },
    response: { content: 'response' },
    ...extra,
  } as CapturedRequestRecord;
}
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('review boundaries for folded model calls', () => {
  it('redacts the same request content in v1 and v2, including tool prose and options', () => {
    const request = {
      messages: [{ role: 'user', content: 'PRIVATE', providerMetadata: { token: 'PRIVATE' } }],
      tools: [
        { name: 'safe_tool', description: 'PRIVATE', parameters: { description: 'PRIVATE' } },
      ],
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'safe_schema', schema: { description: 'PRIVATE' } },
      },
      options: { model: 'm', maxTokens: 7, stop: ['PRIVATE'], toolChoice: { prompt: 'PRIVATE' } },
    };
    const first = start({ request, executionId: 'exec' });
    const last = end({
      executionId: 'exec',
      response: {
        content: 'response',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        cost: 0.02,
      },
    });
    const v1 = redactCapturedRequest(first);
    const v2 = redactModelCallRecord(foldJournal([first, last])[0]);
    expect(v2.kind).toBe('chat');
    if (v2.kind !== 'chat' && v2.kind !== 'stream') throw new Error('expected model call');
    expect(v2.request).toEqual(v1.request);
    expect(JSON.stringify(v1.request)).not.toContain('PRIVATE');
    expect(JSON.stringify(v2.request)).not.toContain('PRIVATE');
    expect(v2.request?.tools?.[0]).toMatchObject({
      name: 'safe_tool',
      description: '[redacted]',
      parameters: '[redacted]',
    });
    expect(v2.request?.options).toMatchObject({
      model: 'm',
      maxTokens: 7,
      stop: ['[redacted]'],
      toolChoice: '[redacted]',
    });
    expect(v2.captured.replayable).toBe(false);
    expect(v2).toMatchObject({
      ids: { executionId: 'exec' },
      usage: { total_tokens: 3 },
      cost: 0.02,
    });
  });

  it('snapshots nested custom JSON across iterator yields and after public schema parse', () => {
    const first = start({
      request: {
        messages: [
          {
            role: 'assistant',
            content: 'stable',
            providerMetadata: { nested: { value: 'metadata-before' } },
          },
        ],
        tools: [{ name: 'tool', parameters: { nested: { value: 'tool-before' } } }],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'output', schema: { nested: { value: 'schema-before' } } },
        },
        options: { model: 'm', toolChoice: { nested: { value: 'choice-before' } } },
      },
    });
    const original = json(first);
    const parsed = capturedJournalLineSchema.parse(original);
    (original as any).request.messages[0].providerMetadata.nested.value = 'metadata-after';
    (original as any).request.tools[0].parameters.nested.value = 'tool-after';
    (original as any).request.responseFormat.json_schema.schema.nested.value = 'schema-after';
    (original as any).request.options.toolChoice.nested.value = 'choice-after';
    expect(JSON.stringify(parsed)).not.toContain('-after');
    const yielded = json(first);
    function* lines(): Generator<unknown> {
      yield yielded;
      (yielded as any).request.messages[0].providerMetadata.nested.value = 'metadata-after';
      (yielded as any).request.tools[0].parameters.nested.value = 'tool-after';
      (yielded as any).request.responseFormat.json_schema.schema.nested.value = 'schema-after';
      (yielded as any).request.options.toolChoice.nested.value = 'choice-after';
      yield end();
    }
    const folded = foldJournal(lines())[0];
    expect(JSON.stringify(folded.request)).toContain('metadata-before');
    expect(JSON.stringify(folded.request)).not.toContain('-after');
    const publicParsed = modelCallRecordSchema.parse(folded);
    (folded as any).request.messages[0].providerMetadata.nested.value = 'late';
    (folded as any).request.tools[0].parameters.nested.value = 'late';
    expect(JSON.stringify(publicParsed.request)).not.toContain('late');
  });

  it('snapshots external payloads after parse and across yields', () => {
    const extStart = {
      v: 1,
      kind: 'external',
      phase: 'start',
      operationId: 'external',
      name: 'vendor',
      transportAttempts: 1,
      captured: { ...captured, omitted: [] },
    };
    const extEnd = {
      ...extStart,
      phase: 'end',
      outcomeStatus: 'ok',
      external: { request: { nested: { value: 'before' } }, response: ['before'] },
    };
    const parsed = capturedJournalLineSchema.parse(extEnd);
    extEnd.external.request.nested.value = 'after';
    extEnd.external.response[0] = 'after';
    expect(JSON.stringify(parsed)).not.toContain('after');
    extEnd.external.request.nested.value = 'before';
    extEnd.external.response[0] = 'before';
    const yielded = json(extEnd);
    function* lines(): Generator<unknown> {
      yield extStart;
      yield yielded;
      yielded.external.request.nested.value = 'late';
      yielded.external.response[0] = 'late';
    }
    const folded = foldJournal(lines())[0];
    expect(JSON.stringify(folded)).toContain('before');
    expect(JSON.stringify(folded)).not.toContain('late');
    const publicParsed = externalOperationRecordSchema.parse(folded);
    (folded as any).external.request.nested.value = 'latest';
    expect(JSON.stringify(publicParsed)).not.toContain('latest');
  });

  it('rejects unsupported external terminal states and preserves a known error stub', () => {
    const extStart = {
      v: 1,
      kind: 'external',
      phase: 'start',
      operationId: 'external',
      name: 'vendor',
      transportAttempts: 1,
      captured: { ...captured, omitted: [] },
    };
    for (const status of ['aborted', 'stalled', 'consumer_closed']) {
      const extEnd = { ...extStart, phase: 'end', outcomeStatus: status };
      expect(() => foldJournal([extStart, extEnd])).toThrow(AxlError);
    }
    const extEnd = {
      ...extStart,
      phase: 'end',
      outcomeStatus: 'error',
      captured: { ...captured, truncated: true, omitted: ['record'] },
    };
    expect(foldJournal([extStart, extEnd])[0].outcome).toEqual({
      status: 'error',
      payloadOmitted: true,
    });
  });

  it('keeps unknown additive fields during duplicate checks and validates their JSON values', () => {
    const a = { ...start(), futureField: { nested: ['a'] } };
    const b = { ...start(), futureField: { nested: ['b'] } };
    expect((capturedJournalLineSchema.parse(a) as any).futureField).toEqual({ nested: ['a'] });
    expect(foldJournal([a, json(a), end()])).toHaveLength(1);
    expect(() => foldJournal([a, b])).toThrow(AxlError);
    expect(() => foldJournal([{ ...a, futureField: { nested: [() => 1] } }])).toThrow(AxlError);
    expect(
      capturedJournalLineSchema.safeParse({ ...a, futureField: { nested: [undefined] } }).success,
    ).toBe(false);
  });

  it('rejects settlement-only fields on start and attempt lines', () => {
    const settlement = {
      endedAt: '2026-10-16T00:00:01.000Z',
      durationMs: 1,
      timing: { attempts: 1 },
      outcomeStatus: 'ok',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0.1,
      costProvenance: 'provider_reported',
      finishReason: 'stop',
      rawFinishReason: 'end',
      responseId: 'r',
      responseModel: 'm2',
      error: { message: 'bad' },
      termination: 'aborted',
      response: { content: 'x' },
      partial: { content: 'x' },
    };
    for (const phase of ['start', 'attempt'] as const) {
      const base =
        phase === 'start' ? start() : { ...start(), phase: 'attempt', request: undefined };
      for (const [key, value] of Object.entries(settlement)) {
        const raw = json({ ...base, [key]: value });
        expect(capturedJournalLineSchema.safeParse(raw).success, `${phase}.${key}`).toBe(false);
        expect(() => foldJournal([raw]), `${phase}.${key}`).toThrow(AxlError);
      }
    }
    expect(() => foldJournal([json({ ...end(), partial: { content: 'x' } })])).toThrow(AxlError);
  });

  it('rejects array getter payloads without invoking them', () => {
    for (const getter of [
      () => 'unstable',
      () => {
        throw new Error('getter invoked');
      },
    ]) {
      let calls = 0;
      const array: unknown[] = ['placeholder'];
      Object.defineProperty(array, '0', {
        configurable: true,
        enumerable: true,
        get() {
          calls++;
          return getter();
        },
      });
      const raw = start({
        request: {
          messages: [{ role: 'user', content: 'x', providerMetadata: { array } }],
          options: { model: 'm' },
        },
      });
      expect(() => capturedJournalLineSchema.safeParse(raw)).not.toThrow();
      expect(capturedJournalLineSchema.safeParse(raw).success).toBe(false);
      expect(() => foldJournal([raw])).toThrow(AxlError);
      expect(calls).toBe(0);
    }
  });
});
