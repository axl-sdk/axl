import type {
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  LegacyExecutionInfoV1,
  ExecutionInfoV2,
} from './types.js';

export class UnsupportedEventSchemaVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported Axl event schema version: ${String(version)}`);
    this.name = 'UnsupportedEventSchemaVersionError';
  }
}

/** Missing event metadata is the documented v1 sentinel. */
export function getEventSchemaVersion(event: { schemaVersion?: unknown }): 1 | 2 {
  const version = event.schemaVersion === undefined ? 1 : event.schemaVersion;
  if (version !== 1 && version !== 2) throw new UnsupportedEventSchemaVersionError(version);
  return version;
}

/** Missing execution metadata is the documented v1 sentinel. */
export function getExecutionEventSchemaVersion(execution: { eventSchemaVersion?: unknown }): 1 | 2 {
  const version = execution.eventSchemaVersion === undefined ? 1 : execution.eventSchemaVersion;
  if (version !== 1 && version !== 2) throw new UnsupportedEventSchemaVersionError(version);
  return version;
}

/**
 * Normalize one state-store row without reinterpreting event payloads.
 * Every event must agree with the execution carrier; mixed-version traces fail
 * loudly instead of being guessed into either reducer.
 */
export function normalizeStoredExecution(
  execution: HistoricalExecutionInfo,
): HistoricalExecutionInfo {
  const version = getExecutionEventSchemaVersion(execution);
  if (!Array.isArray(execution.events)) {
    throw new TypeError(`Execution ${execution.executionId} has a non-array events field`);
  }
  for (const event of execution.events as HistoricalAxlEvent[]) {
    const eventVersion = getEventSchemaVersion(event);
    if (eventVersion !== version) {
      throw new Error(
        `Execution ${execution.executionId} declares event schema v${version} ` +
          `but contains a v${eventVersion} event`,
      );
    }
  }

  if (version === 2) {
    return { ...execution, eventSchemaVersion: 2 } as ExecutionInfoV2;
  }
  return { ...execution, eventSchemaVersion: 1 } as LegacyExecutionInfoV1;
}
