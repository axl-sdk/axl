export type { TelemetryConfig, SpanHandle, SpanManager } from './types.js';
export { NoopSpanManager } from './noop.js';
export { OTelSpanManager } from './span-manager.js';

import type { TelemetryConfig, SpanManager } from './types.js';
import { NoopSpanManager } from './noop.js';

/**
 * Create a SpanManager based on configuration.
 * Returns NoopSpanManager when telemetry is disabled (zero overhead).
 * Dynamically imports OTelSpanManager when enabled (avoids hard dep).
 */
export async function createSpanManager(config?: TelemetryConfig): Promise<SpanManager> {
  if (!config?.enabled) {
    return new NoopSpanManager();
  }

  const { OTelSpanManager } = await import('./span-manager.js');
  return OTelSpanManager.create(config);
}
