import { describe, expect, it } from 'vitest';
import type { AxlEventV2, AxlEventV2Of } from '@axlsdk/axl';
import { getBarColor, getEventColor, isFailureEvent } from '../client/lib/trace-utils.js';
import {
  emptyCostData,
  emptyTraceStatsData,
  reduceCost,
  reduceTraceStats,
} from '../server/aggregates/reducers.js';
import { redactStreamEvent } from '../server/redact.js';

const base = {
  schemaVersion: 2 as const,
  executionId: 'exec',
  askId: 'ask',
  depth: 0,
  agent: 'agent',
  step: 1,
  timestamp: 1,
  tool: 'lookup',
  callId: 'call',
};

describe('v2 tool lifecycle compatibility', () => {
  it('renders rejection, failed, and denied terminals as failure states', () => {
    const rejection: AxlEventV2Of<'tool_call_rejected'> = {
      ...base,
      type: 'tool_call_rejected',
      data: { reason: 'invalid_json', requestedTool: 'lookup', message: 'private' },
    };
    const outcomes: AxlEventV2Of<'tool_call_end'>['data']['outcome'][] = [
      {
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'unexpected',
          disposition: 'abort',
          attempts: 1,
          error: { name: 'Error', message: 'private' },
        },
      },
      { status: 'denied', reason: 'private' },
    ];

    expect(getBarColor(rejection.type)).not.toBe(getBarColor('unknown-future-event'));
    expect(isFailureEvent(rejection)).toBe(true);
    for (const outcome of outcomes) {
      expect(
        isFailureEvent({
          ...base,
          type: 'tool_call_end',
          duration: 1,
          data: { args: {}, outcome },
        }),
      ).toBe(true);
    }
  });

  it('renders cancellation as an amber terminal rather than a failure', () => {
    const cancelled: AxlEventV2Of<'tool_call_end'> = {
      ...base,
      type: 'tool_call_end',
      duration: 1,
      data: {
        args: {},
        outcome: {
          status: 'cancelled',
          cancellation: { phase: 'handler', reason: 'private' },
        },
      },
    };

    expect(isFailureEvent(cancelled)).toBe(false);
    expect(getEventColor(cancelled)).toBe('bg-amber-500');
  });

  it('keeps v1 counters separate while understanding v2 denial and rejection shapes', () => {
    const denial: AxlEventV2Of<'tool_call_end'> = {
      ...base,
      type: 'tool_call_end',
      duration: 1,
      data: { args: {}, outcome: { status: 'denied', reason: 'no' } },
    };
    const rejection: AxlEventV2Of<'tool_call_rejected'> = {
      ...base,
      step: 2,
      type: 'tool_call_rejected',
      data: { reason: 'unavailable', requestedTool: 'lookup', availableTools: [] },
    };

    let state = reduceTraceStats(emptyTraceStatsData(), denial);
    state = reduceTraceStats(state, rejection);

    expect(state.byTool.lookup).toMatchObject({
      accepted: 0,
      succeeded: 0,
      failed: 0,
      denied: 1,
      cancelled: 0,
      rejected: 1,
      approved: 0,
      legacy: { calls: 0, approved: 0, denied: 0 },
    });
    expect(state.eventTypeCounts.tool_call_rejected).toBe(1);
  });

  it('counts accepted calls and each v2 terminal without mixing legacy totals', () => {
    const events: AxlEventV2[] = [
      { ...base, type: 'tool_call_start', data: { args: {} } },
      {
        ...base,
        type: 'tool_call_end',
        duration: 1,
        data: { args: {}, outcome: { status: 'succeeded', result: { ok: true } } },
      },
      {
        ...base,
        step: 2,
        callId: 'failed-call',
        type: 'tool_call_start',
        data: { args: {} },
      },
      {
        ...base,
        step: 3,
        callId: 'failed-call',
        type: 'tool_call_end',
        duration: 1,
        data: {
          args: {},
          outcome: {
            status: 'failed',
            failure: {
              phase: 'projection',
              kind: 'output',
              disposition: 'abort',
              error: { name: 'Error', message: 'private' },
              result: { ok: true },
            },
          },
        },
      },
      {
        ...base,
        step: 4,
        callId: 'cancelled-call',
        type: 'tool_call_start',
        data: { args: {} },
      },
      {
        ...base,
        step: 5,
        callId: 'cancelled-call',
        type: 'tool_call_end',
        duration: 1,
        data: {
          args: {},
          outcome: { status: 'cancelled', cancellation: { phase: 'handler' } },
        },
      },
      {
        ...base,
        step: 6,
        callId: 'rejected-call',
        type: 'tool_call_rejected',
        data: { reason: 'unavailable', requestedTool: 'lookup', availableTools: [] },
      },
    ];

    const state = events.reduce(reduceTraceStats, emptyTraceStatsData());
    expect(state.byTool.lookup).toMatchObject({
      accepted: 3,
      succeeded: 1,
      failed: 1,
      failedByPhase: { projection: 1 },
      denied: 0,
      cancelled: 1,
      rejected: 1,
      legacy: { calls: 0, approved: 0, denied: 0 },
    });

    const billable: AxlEventV2 = {
      schemaVersion: 2,
      executionId: 'exec',
      step: 0,
      timestamp: 1,
      type: 'agent_call_end',
      askId: 'ask',
      depth: 0,
      agent: 'agent',
      model: 'mock:model',
      cost: 0.25,
      tokens: { input: 10, output: 5 },
      duration: 2,
      data: { response: '', turn: 1 },
    };
    const billed = reduceCost(emptyCostData(), billable);
    expect(events.reduce(reduceCost, billed)).toEqual(billed);
  });

  it('redacts v2 rejection payloads without dropping schema metadata', () => {
    const event: AxlEventV2 = {
      ...base,
      type: 'tool_call_rejected',
      data: {
        reason: 'invalid_arguments',
        requestedTool: 'lookup',
        args: { secret: true },
        issues: [{ path: ['secret'], code: 'invalid_type', message: 'private' }],
      },
    };

    expect(redactStreamEvent(event, true)).toMatchObject({
      schemaVersion: 2,
      type: 'tool_call_rejected',
      data: {
        args: '[redacted]',
        issues: [{ path: ['secret'], code: 'invalid_type', message: '[redacted]' }],
      },
    });
  });
});
