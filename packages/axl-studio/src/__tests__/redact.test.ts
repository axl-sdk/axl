import { describe, it, expect } from 'vitest';
import {
  redactExecutionInfo,
  redactExecutionList,
  redactMemoryValue,
  redactMemoryList,
  redactSessionHistory,
  redactValue,
  redactStreamEvent,
  redactEvalResult,
  redactEvalHistoryList,
  redactPendingDecision,
  redactPendingDecisionList,
} from '../server/redact.js';
import type { ExecutionInfo, ChatMessage, PendingDecision } from '@axlsdk/axl';
// StreamEvent is the legacy wire shape, defined locally on the redact module
// (see TODO in redact.ts about PR-3-spec-16).
import type { StreamEvent } from '../server/redact.js';
import type { EvalResult } from '@axlsdk/eval';

function makeExecution(overrides: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return {
    executionId: 'exec-1',
    workflow: 'qa-workflow',
    status: 'completed',
    startedAt: 1000,
    events: [],
    duration: 500,
    totalCost: 0.05,
    result: { answer: 'sensitive user content' },
    ...overrides,
  } as ExecutionInfo;
}

describe('redactExecutionInfo', () => {
  it('returns the original object reference when redact is false', () => {
    const info = makeExecution();
    expect(redactExecutionInfo(info, false)).toBe(info);
  });

  it('scrubs result and error when redact is true', () => {
    const info = makeExecution({
      result: { answer: 'secret' },
      error: 'sensitive error message',
    });
    const out = redactExecutionInfo(info, true);
    expect(out.result).toBe('[redacted]');
    expect(out.error).toBe('[redacted]');
  });

  it('preserves metadata when redact is true', () => {
    const info = makeExecution({
      result: { ssn: '123-45-6789' },
    });
    const out = redactExecutionInfo(info, true);
    // Structural fields must remain visible so Trace Explorer can still
    // render useful context under compliance mode.
    expect(out.executionId).toBe(info.executionId);
    expect(out.workflow).toBe(info.workflow);
    expect(out.status).toBe(info.status);
    expect(out.duration).toBe(info.duration);
    expect(out.totalCost).toBe(info.totalCost);
    expect(out.startedAt).toBe(info.startedAt);
  });

  it('does not mutate the input', () => {
    const info = makeExecution({ result: { secret: true } });
    const out = redactExecutionInfo(info, true);
    expect(info.result).toEqual({ secret: true });
    expect(out).not.toBe(info);
  });

  it('leaves undefined result alone (not replaced with `[redacted]`)', () => {
    const info = makeExecution({ result: undefined });
    const out = redactExecutionInfo(info, true);
    // undefined result means the workflow returned nothing sensitive — don't
    // invent a `[redacted]` marker for a field that was never populated.
    expect(out.result).toBeUndefined();
  });

  it('handles string results (workflow returned a plain string)', () => {
    const info = makeExecution({ result: 'just a string answer' });
    const out = redactExecutionInfo(info, true);
    expect(out.result).toBe('[redacted]');
  });
});

describe('redactExecutionList', () => {
  it('returns the original array reference when redact is false', () => {
    const list = [makeExecution(), makeExecution({ executionId: 'exec-2' })];
    expect(redactExecutionList(list, false)).toBe(list);
  });

  it('scrubs each entry when redact is true', () => {
    const list = [
      makeExecution({ result: 'a' }),
      makeExecution({ executionId: 'exec-2', result: { foo: 'b' } }),
    ];
    const out = redactExecutionList(list, true);
    expect(out).toHaveLength(2);
    for (const entry of out) {
      expect(entry.result).toBe('[redacted]');
    }
  });
});

describe('redactMemoryValue', () => {
  it('returns the original value when redact is false', () => {
    const value = { sensitive: 'data' };
    expect(redactMemoryValue(value, false)).toBe(value);
  });

  it('returns `[redacted]` when redact is true', () => {
    expect(redactMemoryValue({ ssn: '123-45-6789' }, true)).toBe('[redacted]');
    expect(redactMemoryValue('plain string', true)).toBe('[redacted]');
    expect(redactMemoryValue(42, true)).toBe('[redacted]');
    expect(redactMemoryValue(null, true)).toBe('[redacted]');
  });
});

describe('redactMemoryList', () => {
  it('returns the original array when redact is false', () => {
    const list = [{ key: 'a', value: 'one' }];
    expect(redactMemoryList(list, false)).toBe(list);
  });

  it('scrubs values but preserves keys so the memory browser stays navigable', () => {
    const list = [
      { key: 'user:john@acme.com', value: 'sensitive profile data' },
      { key: 'preferences', value: { theme: 'dark', secret: 'x' } },
    ];
    const out = redactMemoryList(list, true);
    expect(out).toEqual([
      { key: 'user:john@acme.com', value: '[redacted]' },
      { key: 'preferences', value: '[redacted]' },
    ]);
  });

  it('does not mutate the input list', () => {
    const list = [{ key: 'a', value: 'one' }];
    redactMemoryList(list, true);
    expect(list[0].value).toBe('one');
  });
});

describe('redactSessionHistory', () => {
  function userMsg(content: string): ChatMessage {
    return { role: 'user', content };
  }
  function assistantMsg(content: string, tool_calls?: ChatMessage['tool_calls']): ChatMessage {
    return { role: 'assistant', content, tool_calls };
  }
  function toolMsg(content: string, tool_call_id: string, name: string): ChatMessage {
    return { role: 'tool', content, tool_call_id, name };
  }

  it('returns the original history when redact is false', () => {
    const history = [userMsg('hello'), assistantMsg('hi there')];
    expect(redactSessionHistory(history, false)).toBe(history);
  });

  it('scrubs message content but preserves role', () => {
    const history = [userMsg('my SSN is 123-45-6789'), assistantMsg('I cannot help with that.')];
    const out = redactSessionHistory(history, true);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('[redacted]');
    expect(out[1].role).toBe('assistant');
    expect(out[1].content).toBe('[redacted]');
  });

  it('scrubs tool call arguments but preserves function name and ids', () => {
    const history: ChatMessage[] = [
      assistantMsg('calling tool', [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'send_email', arguments: '{"to":"john@acme.com","body":"secret"}' },
        },
      ]),
    ];
    const out = redactSessionHistory(history, true);
    const tc = out[0].tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc!.id).toBe('call_1');
    expect(tc!.type).toBe('function');
    expect(tc!.function.name).toBe('send_email');
    expect(tc!.function.arguments).toBe('[redacted]');
  });

  it('preserves tool_call_id and name on tool-role messages', () => {
    const history = [toolMsg('weather result: 72F', 'call_1', 'get_weather')];
    const out = redactSessionHistory(history, true);
    expect(out[0].role).toBe('tool');
    expect(out[0].content).toBe('[redacted]');
    expect(out[0].tool_call_id).toBe('call_1');
    expect(out[0].name).toBe('get_weather');
  });

  it('strips providerMetadata (opaque bag of potentially sensitive data)', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'response',
        providerMetadata: {
          thoughtSignature: 'encrypted-reasoning-blob',
          cacheKey: 'tenant-42-cache',
        },
      },
    ];
    const out = redactSessionHistory(history, true);
    expect(out[0].providerMetadata).toBeUndefined();
  });

  it('does not mutate the input messages', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    redactSessionHistory(history, true);
    expect(history[0].content).toBe('hello');
  });

  it('handles empty content (scrubs to sentinel rather than preserving empty)', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: '' }];
    const out = redactSessionHistory(history, true);
    expect(out[0].content).toBe('[redacted]');
  });

  it('handles zero-length history', () => {
    expect(redactSessionHistory([], true)).toEqual([]);
  });
});

describe('redactValue (generic scalar)', () => {
  it('returns the original value when redact is false', () => {
    const value = { foo: 'bar' };
    expect(redactValue(value, false)).toBe(value);
  });

  it('scrubs any value to the sentinel when redact is true', () => {
    expect(redactValue('hello', true)).toBe('[redacted]');
    expect(redactValue({ foo: 'bar' }, true)).toBe('[redacted]');
    expect(redactValue([1, 2, 3], true)).toBe('[redacted]');
    expect(redactValue(42, true)).toBe('[redacted]');
    expect(redactValue(null, true)).toBe('[redacted]');
    expect(redactValue(undefined, true)).toBe('[redacted]');
  });

  it('scrubs a value that is literally the redacted sentinel string', () => {
    // If a user happened to store the literal string '[redacted]' as a value,
    // redacting it is a no-op (idempotent). Shouldn't crash or double-wrap.
    expect(redactValue('[redacted]', true)).toBe('[redacted]');
  });
});

describe('redactStreamEvent', () => {
  it('returns the original event when redact is false', () => {
    const event: StreamEvent = { type: 'token', data: 'hello' };
    expect(redactStreamEvent(event, false)).toBe(event);
  });

  it('scrubs token.data', () => {
    const out = redactStreamEvent({ type: 'token', data: 'sensitive' }, true);
    expect(out).toEqual({ type: 'token', data: '[redacted]' });
  });

  it('scrubs tool_call.args but preserves name/callId', () => {
    const out = redactStreamEvent(
      { type: 'tool_call', name: 'send_email', args: { to: 'x@y.z' }, callId: 'call_1' },
      true,
    );
    expect(out).toEqual({
      type: 'tool_call',
      name: 'send_email',
      args: '[redacted]',
      callId: 'call_1',
    });
  });

  it('scrubs tool_result.result but preserves name/callId', () => {
    const out = redactStreamEvent(
      { type: 'tool_result', name: 'fetch', result: { data: 'secret' }, callId: 'call_2' },
      true,
    );
    expect(out).toEqual({
      type: 'tool_result',
      name: 'fetch',
      result: '[redacted]',
      callId: 'call_2',
    });
  });

  it('scrubs tool_approval.args and .reason', () => {
    const out = redactStreamEvent(
      {
        type: 'tool_approval',
        name: 'delete',
        args: { id: 1 },
        approved: false,
        reason: 'user denied — contains PII',
      },
      true,
    );
    expect(out).toEqual({
      type: 'tool_approval',
      name: 'delete',
      args: '[redacted]',
      approved: false,
      reason: '[redacted]',
    });
  });

  it('scrubs done.data', () => {
    const out = redactStreamEvent({ type: 'done', data: { result: 'sensitive' } }, true);
    expect(out).toEqual({ type: 'done', data: '[redacted]' });
  });

  it('scrubs error.message', () => {
    const out = redactStreamEvent(
      { type: 'error', message: 'Failed: user john@acme.com not found' },
      true,
    );
    expect(out).toEqual({ type: 'error', message: '[redacted]' });
  });

  it('passes through structural events (agent_start, agent_end, handoff, step)', () => {
    const events: StreamEvent[] = [
      { type: 'agent_start', agent: 'a1', model: 'mock:gpt-4o' },
      { type: 'agent_end', agent: 'a1', cost: 0.05, duration: 100 },
      { type: 'handoff', source: 'a1', target: 'a2', mode: 'oneway' },
      { type: 'step', step: 1, data: { type: 'agent_call', data: '[already redacted]' } },
    ];
    for (const event of events) {
      expect(redactStreamEvent(event, true)).toBe(event);
    }
  });
});

describe('redactEvalResult', () => {
  function makeItem(overrides: Record<string, unknown> = {}) {
    return {
      input: { question: 'sensitive' },
      output: 'sensitive answer',
      scores: { accuracy: 0.9 },
      duration: 100,
      cost: 0.001,
      ...overrides,
    } as never;
  }

  function makeResult(items: unknown[] = [makeItem()]): EvalResult {
    return {
      id: 'eval-1',
      dataset: 'test-dataset',
      metadata: { scorerTypes: { accuracy: 'deterministic' } },
      timestamp: '2025-01-01',
      totalCost: 0.01,
      duration: 500,
      items: items as never,
      summary: {
        count: items.length,
        failures: 0,
        scorers: { accuracy: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9 } },
      },
    };
  }

  it('returns the original result when redact is false', () => {
    const result = makeResult();
    expect(redactEvalResult(result, false)).toBe(result);
  });

  it('scrubs input/output on every item', () => {
    const result = makeResult([makeItem(), makeItem()]);
    const out = redactEvalResult(result, true);
    for (const item of out.items) {
      expect(item.input).toBe('[redacted]');
      expect(item.output).toBe('[redacted]');
    }
  });

  it('preserves scores, duration, cost on items', () => {
    const result = makeResult();
    const out = redactEvalResult(result, true);
    expect(out.items[0].scores).toEqual({ accuracy: 0.9 });
    expect(out.items[0].duration).toBe(100);
    expect(out.items[0].cost).toBe(0.001);
  });

  it('preserves result-level summary and metadata', () => {
    const result = makeResult();
    const out = redactEvalResult(result, true);
    expect(out.summary).toEqual(result.summary);
    expect(out.metadata).toEqual(result.metadata);
    expect(out.totalCost).toBe(result.totalCost);
    expect(out.duration).toBe(result.duration);
    expect(out.id).toBe(result.id);
    expect(out.dataset).toBe(result.dataset);
  });

  it('scrubs annotations, error, scorerErrors', () => {
    const result = makeResult([
      makeItem({
        annotations: { ground_truth: 'secret' },
        error: 'failed on input john@acme.com',
        scorerErrors: ['scorer threw: secret detail'],
      }),
    ]);
    const out = redactEvalResult(result, true);
    expect(out.items[0].annotations).toBe('[redacted]');
    expect(out.items[0].error).toBe('[redacted]');
    expect(out.items[0].scorerErrors).toEqual(['[redacted]']);
  });

  it('scrubs scoreDetails[*].metadata but keeps score/duration/cost', () => {
    const result = makeResult([
      makeItem({
        scoreDetails: {
          accuracy: {
            score: 0.9,
            metadata: { reasoning: 'LLM scorer saw the raw output' },
            duration: 50,
            cost: 0.0001,
          },
        },
      }),
    ]);
    const out = redactEvalResult(result, true);
    const detail = out.items[0].scoreDetails!.accuracy;
    expect(detail.score).toBe(0.9);
    expect(detail.duration).toBe(50);
    expect(detail.cost).toBe(0.0001);
    expect(detail.metadata).toBeUndefined();
  });

  it('handles empty items list', () => {
    const result = makeResult([]);
    const out = redactEvalResult(result, true);
    expect(out.items).toEqual([]);
  });
});

describe('redactEvalHistoryList', () => {
  it('returns the original array when redact is false', () => {
    const history = [
      { id: 'h1', eval: 'test', timestamp: 1, data: { items: [] } as unknown as EvalResult },
    ];
    expect(redactEvalHistoryList(history, false)).toBe(history);
  });

  it('scrubs the nested data on every entry', () => {
    const history = [
      {
        id: 'h1',
        eval: 'test',
        timestamp: 1,
        data: {
          id: 'e1',
          dataset: 'd',
          metadata: {},
          timestamp: '',
          totalCost: 0,
          duration: 0,
          items: [{ input: 'raw', output: 'raw', scores: {} }] as never,
          summary: { count: 1, failures: 0, scorers: {} },
        } satisfies EvalResult,
      },
    ];
    const out = redactEvalHistoryList(history, true);
    const firstItem = (out[0].data as EvalResult).items[0];
    expect(firstItem.input).toBe('[redacted]');
    expect(firstItem.output).toBe('[redacted]');
    expect(out[0].id).toBe('h1');
    expect(out[0].eval).toBe('test');
  });
});

describe('redactPendingDecision', () => {
  function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
    return {
      executionId: 'exec-1',
      channel: 'approval',
      prompt: 'Approve sending this email to user@acme.com?',
      metadata: { userId: '42' },
      createdAt: '2025-01-01',
      ...overrides,
    };
  }

  it('returns original when redact is false', () => {
    const decision = makeDecision();
    expect(redactPendingDecision(decision, false)).toBe(decision);
  });

  it('scrubs prompt and metadata, preserves structural fields', () => {
    const decision = makeDecision();
    const out = redactPendingDecision(decision, true);
    expect(out.executionId).toBe('exec-1');
    expect(out.channel).toBe('approval');
    expect(out.createdAt).toBe('2025-01-01');
    expect(out.prompt).toBe('[redacted]');
    expect(out.metadata).toEqual({ redacted: true });
  });

  it('omits metadata replacement when original has no metadata', () => {
    const decision = makeDecision({ metadata: undefined });
    const out = redactPendingDecision(decision, true);
    expect(out.metadata).toBeUndefined();
    expect(out.prompt).toBe('[redacted]');
  });
});

describe('redactPendingDecisionList', () => {
  it('maps every entry', () => {
    const list: PendingDecision[] = [
      {
        executionId: 'e1',
        channel: 'c',
        prompt: 'sensitive 1',
        createdAt: '',
      },
      {
        executionId: 'e2',
        channel: 'c',
        prompt: 'sensitive 2',
        createdAt: '',
      },
    ];
    const out = redactPendingDecisionList(list, true);
    for (const d of out) {
      expect(d.prompt).toBe('[redacted]');
    }
  });
});
