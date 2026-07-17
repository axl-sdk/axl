import { describe, expect, it } from 'vitest';
import { REDACTED, redactHistoricalEvent } from '../redaction.js';
import type { AxlEventV2Of, ToolCallOutcome } from '../types.js';

function toolEnd(outcome: ToolCallOutcome): AxlEventV2Of<'tool_call_end'> {
  return {
    schemaVersion: 2,
    type: 'tool_call_end',
    executionId: 'exec',
    askId: 'ask',
    depth: 0,
    agent: 'agent',
    step: 2,
    timestamp: 2,
    tool: 'lookup',
    callId: 'call',
    duration: 1,
    data: { args: { secret: 'value' }, outcome },
  };
}

describe('v2 event redaction', () => {
  it('redacts rejection inputs and messages while preserving structural issues', () => {
    const event: AxlEventV2Of<'tool_call_rejected'> = {
      schemaVersion: 2,
      type: 'tool_call_rejected',
      executionId: 'exec',
      askId: 'ask',
      depth: 0,
      agent: 'agent',
      step: 1,
      timestamp: 1,
      tool: 'lookup',
      callId: 'call',
      data: {
        reason: 'invalid_arguments',
        requestedTool: 'lookup',
        args: { secret: 'value' },
        issues: [{ path: ['secret'], code: 'invalid_type', message: 'got value' }],
      },
    };

    expect(redactHistoricalEvent(event)).toEqual({
      ...event,
      data: {
        ...event.data,
        args: REDACTED,
        issues: [{ path: ['secret'], code: 'invalid_type', message: REDACTED }],
      },
    });
  });

  it.each([
    {
      outcome: { status: 'succeeded', result: { secret: true } } as const,
      expected: { status: 'succeeded', result: REDACTED },
    },
    {
      outcome: { status: 'denied', reason: 'private reason' } as const,
      expected: { status: 'denied', reason: REDACTED },
    },
    {
      outcome: {
        status: 'cancelled',
        cancellation: { phase: 'after_handler', result: 'private', reason: 'private reason' },
      } as const,
      expected: {
        status: 'cancelled',
        cancellation: { phase: 'after_handler', result: REDACTED, reason: REDACTED },
      },
    },
    {
      outcome: {
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'unexpected',
          disposition: 'abort',
          attempts: 1,
          error: { name: 'Error', message: 'private message', cause: { secret: true } },
        },
      } as const,
      expected: {
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'unexpected',
          disposition: 'abort',
          attempts: 1,
          error: { name: 'Error', message: REDACTED, cause: REDACTED },
        },
      },
    },
  ])(
    'redacts $outcome.status terminal outcomes without changing status',
    ({ outcome, expected }) => {
      const redacted = redactHistoricalEvent(toolEnd(outcome));
      expect(redacted).toMatchObject({
        schemaVersion: 2,
        type: 'tool_call_end',
        data: { args: REDACTED, outcome: expected },
      });
    },
  );

  it('keeps schemaVersion on non-tool v2 events while reusing content rules', () => {
    const event: AxlEventV2Of<'workflow_start'> = {
      schemaVersion: 2,
      type: 'workflow_start',
      executionId: 'exec',
      workflow: 'workflow',
      step: 0,
      timestamp: 0,
      data: { input: { secret: true } },
    };

    expect(redactHistoricalEvent(event)).toEqual({
      ...event,
      data: { input: REDACTED },
    });
  });
});
