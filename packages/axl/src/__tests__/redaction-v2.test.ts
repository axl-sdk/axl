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

  it.each([
    {
      phase: 'approval',
      kind: 'infrastructure',
      disposition: 'abort',
      error: { name: 'Error', message: 'private approval', cause: 'private cause' },
    },
    {
      phase: 'before_hook',
      kind: 'tool_failure',
      disposition: 'continue',
      error: { name: 'ToolFailure', message: 'private before', cause: 'private cause' },
    },
    {
      phase: 'before_hook',
      kind: 'unexpected',
      disposition: 'abort',
      error: { name: 'Error', message: 'private before', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'tool_failure',
      disposition: 'continue',
      attempts: 2,
      error: { name: 'ToolFailure', message: 'private handler', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'mcp_error',
      disposition: 'continue',
      attempts: 1,
      error: { name: 'McpToolError', message: 'private remote', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'unexpected',
      disposition: 'abort',
      attempts: 3,
      error: { name: 'Error', message: 'private handler', cause: 'private cause' },
    },
    {
      phase: 'after_hook',
      kind: 'tool_failure',
      disposition: 'continue',
      result: { private: 'result' },
      error: { name: 'ToolFailure', message: 'private after', cause: 'private cause' },
    },
    {
      phase: 'after_hook',
      kind: 'unexpected',
      disposition: 'abort',
      result: { private: 'result' },
      error: { name: 'Error', message: 'private after', cause: 'private cause' },
    },
    {
      phase: 'projection',
      kind: 'output',
      disposition: 'abort',
      result: { private: 'result' },
      error: {
        name: 'ToolModelOutputError',
        message: 'private projection',
        cause: 'private cause',
      },
    },
    {
      phase: 'serialization',
      kind: 'output',
      disposition: 'abort',
      result: { private: 'result' },
      error: { name: 'TypeError', message: 'private serialization', cause: 'private cause' },
    },
  ] as const)(
    'redacts every $phase/$kind failure field while preserving its discriminants',
    (failure) => {
      const event = toolEnd({ status: 'failed', failure } as ToolCallOutcome);
      const redacted = redactHistoricalEvent(event) as AxlEventV2Of<'tool_call_end'>;
      expect(redacted).toMatchObject({
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
        data: {
          args: REDACTED,
          outcome: {
            status: 'failed',
            failure: {
              phase: failure.phase,
              kind: failure.kind,
              disposition: failure.disposition,
              error: { name: failure.error.name, message: REDACTED, cause: REDACTED },
              ...('attempts' in failure ? { attempts: failure.attempts } : {}),
              ...('result' in failure ? { result: REDACTED } : {}),
            },
          },
        },
      });
      expect(JSON.stringify(redacted)).not.toContain('private');
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
