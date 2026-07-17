import { describe, expect, it } from 'vitest';
import { STUDIO_TOOL_LIFECYCLE_V1_FIXTURE } from './fixtures/tool-lifecycle-v1.js';
import { executionEventSchemaVersion } from '../client/lib/trace-utils.js';

describe('legacy tool lifecycle fixture', () => {
  it('locks the unversioned shapes Studio must continue to interpret as v1', () => {
    const events = STUDIO_TOOL_LIFECYCLE_V1_FIXTURE.events;
    const returnedErrorEnd = events.find((event) => event.type === 'tool_call_end');
    const deniedApproval = events.find(
      (event) => event.type === 'tool_approval' && !event.data.approved,
    );

    expect({
      sequence: events.map((event) => ({
        type: event.type,
        callId: 'callId' in event ? event.callId : undefined,
        hasCallId: 'callId' in event,
        hasData: 'data' in event,
      })),
      returnedErrorResult:
        returnedErrorEnd?.type === 'tool_call_end' ? returnedErrorEnd.data.result : undefined,
      deniedApproval:
        deniedApproval?.type === 'tool_approval'
          ? { callId: deniedApproval.callId, approved: deniedApproval.data.approved }
          : undefined,
      deniedCallHasEnd: events.some(
        (event) => event.type === 'tool_call_end' && event.callId === 'call-denied',
      ),
    }).toMatchInlineSnapshot(`
      {
        "deniedApproval": {
          "approved": false,
          "callId": "call-denied",
        },
        "deniedCallHasEnd": false,
        "returnedErrorResult": {
          "error": null,
          "id": "case-1",
          "status": "open",
        },
        "sequence": [
          {
            "callId": "call-returned-error",
            "hasCallId": true,
            "hasData": true,
            "type": "tool_call_start",
          },
          {
            "callId": "call-returned-error",
            "hasCallId": true,
            "hasData": true,
            "type": "tool_call_end",
          },
          {
            "callId": undefined,
            "hasCallId": false,
            "hasData": false,
            "type": "tool_denied",
          },
          {
            "callId": "call-denied",
            "hasCallId": true,
            "hasData": true,
            "type": "tool_call_start",
          },
          {
            "callId": "call-denied",
            "hasCallId": true,
            "hasData": true,
            "type": "tool_approval",
          },
        ],
      }
    `);
  });

  it('routes an absent execution carrier to the legacy renderer', () => {
    type StudioExecution = Parameters<typeof executionEventSchemaVersion>[0];
    expect(executionEventSchemaVersion(STUDIO_TOOL_LIFECYCLE_V1_FIXTURE as StudioExecution)).toBe(
      1,
    );
    expect(
      executionEventSchemaVersion({
        ...STUDIO_TOOL_LIFECYCLE_V1_FIXTURE,
        eventSchemaVersion: 2,
      } as StudioExecution),
    ).toBe(2);
  });
});
