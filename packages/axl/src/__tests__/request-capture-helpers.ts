/**
 * Fixtures for the opt-in request-capture suites (plan A10–A12).
 *
 * A capture test needs to be able to say precisely what the sink did — accepted,
 * blocked forever, threw — and to read back exactly the encoded lines that
 * reached it, because "what is in the artifact" is the thing under test.
 */

import { RequestCaptureChannel } from '../diagnostics/capture.js';
import type { CapturedRequestRecord, RequestCaptureSink } from '../diagnostics/capture.js';
import { deferred } from './accounting-helpers.js';

/** A sink that keeps every line it is given. */
export class CollectingSink implements RequestCaptureSink {
  readonly lines: string[] = [];

  async append(line: string): Promise<void> {
    this.lines.push(line);
  }

  /** The records, decoded. */
  records(): CapturedRequestRecord[] {
    return this.lines.map((line) => JSON.parse(line) as CapturedRequestRecord);
  }
}

/** A sink whose writes never settle until the test releases them. */
export class BlockingSink implements RequestCaptureSink {
  readonly gate = deferred();
  attempts = 0;

  async append(_line: string): Promise<void> {
    this.attempts += 1;
    await this.gate.promise;
  }
}

/** A sink that rejects every write. */
export class FailingSink implements RequestCaptureSink {
  constructor(private readonly message = 'disk on fire') {}

  async append(_line: string): Promise<void> {
    throw new Error(this.message);
  }
}

/** Build a channel plus the sink behind it in one call. */
export function channelWith(
  sink: RequestCaptureSink,
  options?: {
    maxRecordBytes?: number;
    maxRunBytes?: number;
    maxQueueBytes?: number;
    redact?: boolean;
    flushTimeoutMs?: number;
  },
): RequestCaptureChannel {
  return new RequestCaptureChannel({ sink, ...options });
}

/** Only the records for one phase, in write order. */
export function phase(
  records: readonly CapturedRequestRecord[],
  wanted: CapturedRequestRecord['phase'],
): CapturedRequestRecord[] {
  return records.filter((record) => record.phase === wanted);
}
