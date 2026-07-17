import { describe, expect, it } from 'vitest';
import {
  getEventSchemaVersion,
  getExecutionEventSchemaVersion,
  normalizeStoredExecution,
  UnsupportedEventSchemaVersionError,
} from '../event-schema.js';
import { AXL_EVENT_TYPES_V2, AXL_TOOL_LIFECYCLE_TYPES_V2 } from '../types.js';
import type { AxlEventV2, HistoricalExecutionInfo, LegacyExecutionInfoV1 } from '../types.js';

const legacyEvent = {
  type: 'tool_denied' as const,
  executionId: 'legacy',
  step: 1,
  timestamp: 1,
  tool: 'missing',
  data: {},
};

function legacyExecution(): LegacyExecutionInfoV1 {
  return {
    executionId: 'legacy',
    workflow: 'workflow',
    status: 'completed',
    events: [legacyEvent],
    totalCost: 0,
    startedAt: 1,
    duration: 0,
  };
}

describe('event schema compatibility', () => {
  it('locks the v2 event and tool lifecycle discriminator tables before emission', () => {
    expect(AXL_EVENT_TYPES_V2).toContain('tool_call_rejected');
    expect(AXL_EVENT_TYPES_V2).not.toContain('tool_denied');
    expect(AXL_TOOL_LIFECYCLE_TYPES_V2).toEqual([
      'tool_call_start',
      'tool_call_end',
      'tool_call_rejected',
    ]);
  });

  it('maps absent event and execution metadata to v1 in one place', () => {
    expect(getEventSchemaVersion(legacyEvent)).toBe(1);
    expect(getExecutionEventSchemaVersion(legacyExecution())).toBe(1);

    const normalized = normalizeStoredExecution(legacyExecution());
    expect(normalized.eventSchemaVersion).toBe(1);
    expect(normalized.events[0]).toEqual(legacyEvent);
    expect(normalized.events[0]).not.toHaveProperty('schemaVersion');
  });

  it('accepts a consistently versioned v2 non-tool trace', () => {
    const event = {
      schemaVersion: 2,
      type: 'workflow_start',
      executionId: 'v2',
      step: 0,
      timestamp: 1,
      workflow: 'workflow',
      data: { input: 'test' },
    } satisfies AxlEventV2;
    const execution = {
      executionId: 'v2',
      workflow: 'workflow',
      status: 'completed',
      eventSchemaVersion: 2,
      events: [event],
      totalCost: 0,
      startedAt: 1,
      duration: 0,
    } satisfies HistoricalExecutionInfo;

    expect(normalizeStoredExecution(execution)).toEqual(execution);
  });

  it('fails loudly for unsupported and mixed versions', () => {
    for (const schemaVersion of [null, 0, 3]) {
      expect(() => getEventSchemaVersion({ schemaVersion })).toThrow(
        UnsupportedEventSchemaVersionError,
      );
    }
    for (const eventSchemaVersion of [null, 0, 3]) {
      expect(() => getExecutionEventSchemaVersion({ eventSchemaVersion })).toThrow(
        UnsupportedEventSchemaVersionError,
      );
    }
    expect(() =>
      normalizeStoredExecution({
        ...legacyExecution(),
        eventSchemaVersion: 1,
        events: [{ ...legacyEvent, schemaVersion: 2 } as never],
      }),
    ).toThrow('declares event schema v1 but contains a v2 event');
    expect(() =>
      normalizeStoredExecution({
        ...legacyExecution(),
        eventSchemaVersion: 2,
      } as HistoricalExecutionInfo),
    ).toThrow('declares event schema v2 but contains a v1 event');
  });
});
