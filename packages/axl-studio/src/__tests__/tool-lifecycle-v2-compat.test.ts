import { describe, expect, it } from 'vitest';
import type { AxlEventV2, AxlEventV2Of } from '@axlsdk/axl';
import { getBarColor, isFailureEvent } from '../client/lib/trace-utils.js';
import { emptyTraceStatsData, reduceTraceStats } from '../server/aggregates/reducers.js';
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
  it('renders rejection and every non-success terminal as a failure state', () => {
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
      { status: 'cancelled', cancellation: { phase: 'handler', reason: 'private' } },
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

    expect(state.byTool.lookup).toEqual({ calls: 1, approved: 0, denied: 1 });
    expect(state.eventTypeCounts.tool_call_rejected).toBe(1);
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
