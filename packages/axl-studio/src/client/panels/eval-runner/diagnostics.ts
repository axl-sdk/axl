/**
 * Client-side reading of a run's captured-request diagnostics.
 *
 * Everything here is pure and byte-honest. The one property every function
 * below defends is that **the UI never states more than the artifact supports**:
 * a downgraded manifest's stale counters are not repeated as fact, an absent
 * field renders as unknown rather than as zero, and the inline viewer's cap is
 * something the reader is told about rather than something that silently eats
 * records.
 */
import type { DiagnosticManifest, EvalResultData, RequestRecord } from './types';

/**
 * How many OPERATIONS the inline viewer holds.
 *
 * An artifact is allowed to be 16 MiB across tens of thousands of records, and
 * a browser tab that parses all of them into React state to render a list is
 * how a diagnostics read takes the page down. The cap is deliberately a
 * *reader* bound, not a fetch bound: the stream is cancelled once the cap is
 * reached, so the client never holds more than this many operations regardless
 * of how large the artifact is. Anything past it is the download's job.
 *
 * The unit is the operation, not the JSONL line, because a line is half a turn:
 * a `start` carries the request and its `end` carries the response. A cap
 * counted in lines both halves the number of turns the reader actually gets and
 * can cut between a `start` and its `end`, leaving the last operation of the
 * page looking like a call that never came back.
 */
export const MAX_INLINE_OPERATIONS = 200;

/**
 * The manifest a result carries, or `undefined` when it carries none.
 *
 * A legacy artifact (pre-capture) and a run that simply did not opt in are
 * indistinguishable at this layer and both return `undefined` — the caller
 * renders nothing for both, which is the honest reading.
 */
export function readDiagnostics(
  result: EvalResultData | null | undefined,
): DiagnosticManifest | undefined {
  const manifest = result?.diagnostics;
  if (!manifest || typeof manifest !== 'object') return undefined;
  if (typeof manifest.artifactId !== 'string' || typeof manifest.status !== 'string') {
    return undefined;
  }
  return manifest;
}

/**
 * Whether a manifest still points at readable evidence.
 *
 * `status: 'unavailable'` and the empty-string artifact id are the two
 * sentinels the runtime stamps when the bytes are gone; either one means there
 * is nothing to download and nothing to view.
 */
export function hasReadableRecords(manifest: DiagnosticManifest | undefined): boolean {
  if (!manifest) return false;
  return manifest.status !== 'unavailable' && manifest.artifactId !== '';
}

/**
 * Whether a history row should advertise captured requests.
 *
 * Stricter than `hasReadableRecords`: a row indicator is a promise that opening
 * the run shows something, so a committed-but-empty artifact (0 records) does
 * not earn one.
 */
export function hasCapturedRequests(result: EvalResultData | null | undefined): boolean {
  const manifest = readDiagnostics(result);
  return hasReadableRecords(manifest) && (manifest?.records ?? 0) > 0;
}

/**
 * Counters a downgraded manifest must not be believed about.
 *
 * `runtime.downgradeDiagnostics` zeroes `records`/`bytes` when it declares an
 * artifact gone, but a result persisted by an older build (or an imported blob
 * written by one) can still carry `status: 'unavailable', records: 137`. The
 * count is about evidence that has just been declared absent, so readers take
 * it from here rather than from the manifest.
 */
export function readableCounters(manifest: DiagnosticManifest): {
  records: number | undefined;
  bytes: number | undefined;
} {
  if (!hasReadableRecords(manifest)) return { records: undefined, bytes: undefined };
  return {
    records: Number.isFinite(manifest.records) ? manifest.records : undefined,
    bytes: Number.isFinite(manifest.bytes) ? manifest.bytes : undefined,
  };
}

/** Filename for the downloaded sidecar: `<eval>-<id>.requests.jsonl`. */
export function recordsFilename(evalName: string | undefined, id: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = safe(evalName ?? '') || 'eval';
  const shortId = safe(id) || 'result';
  return `${name}-${shortId}.requests.jsonl`;
}

/** Human byte size. Returns `'unknown'` for anything that is not a real count. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a manifest status means, in a sentence a reader can act on. */
export const STATUS_EXPLANATIONS: Record<DiagnosticManifest['status'], string> = {
  complete: 'every dispatched operation was captured',
  truncated: 'capture stopped at a size limit — some operations are missing',
  interrupted: 'the run ended before capture was finalized — some operations are missing',
  unavailable: 'the captured bytes are not stored',
};

/**
 * Yield the response body as text chunks, streaming where the platform allows.
 *
 * `response.body` is missing in some environments (and in hand-rolled test
 * doubles), so `text()` is the fallback — correctness first, boundedness where
 * it is available.
 */
async function* textChunks(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const whole = await response.text();
    if (whole) yield whole;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    // Releases the connection when the consumer stopped early at the cap.
    await reader.cancel().catch(() => undefined);
  }
}

export type ParsedRecords = {
  records: RequestRecord[];
  /** Lines that were not parseable JSON objects. Reported, never rendered. */
  malformed: number;
  /**
   * True when a record for an operation PAST the cap was actually seen.
   *
   * Never set by reaching the cap exactly: an artifact holding exactly
   * `maxOperations` operations is on screen in full, and saying "download the
   * .jsonl for the rest" about it tells the reader evidence is missing that is
   * not.
   */
  cappedEarly: boolean;
};

/**
 * One operation reassembled from its JSONL lines.
 *
 * The artifact is one line per phase, not one line per call: a `start` carries
 * the request, an `attempt` carries only the identity of a transport retry, and
 * an `end` carries the response, error or termination. Rendering the lines
 * as independent rows makes every completed call read as two half-answers —
 * a request whose response "is not recorded" (which a `start` structurally
 * cannot carry) and a response with no request. This is the reassembly.
 */
export type CapturedOperation = {
  operationId: string;
  /** Every line for this operation, in artifact order. */
  records: RequestRecord[];
  /** The `start` line: the only one that carries the request. */
  start?: RequestRecord;
  /** The `end` line: the only one that carries a response, error or termination. */
  end?: RequestRecord;
  /** `attempt` lines — transport retries of this same operation beyond the first. */
  retries: number;
};

/**
 * Group records into operations, preserving first-appearance order.
 *
 * Defensive about the line shapes on purpose: an artifact on disk may have been
 * written by a build whose phases this one does not know, and a record with no
 * usable `operationId` still has to render rather than vanish (a dropped
 * operation reads as a call that was never made). Such a record becomes its own
 * single-record group.
 */
export function groupOperations(records: readonly RequestRecord[]): CapturedOperation[] {
  const byId = new Map<string, CapturedOperation>();
  const ordered: CapturedOperation[] = [];
  let anonymous = 0;

  for (const record of records) {
    const id = typeof record?.operationId === 'string' ? record.operationId : '';
    const key = id === '' ? `\u0000anonymous-${(anonymous += 1)}` : id;
    let operation = byId.get(key);
    if (!operation) {
      operation = { operationId: id, records: [], retries: 0 };
      byId.set(key, operation);
      ordered.push(operation);
    }
    operation.records.push(record);
    // First line of a phase wins: a re-emitted phase would otherwise let a
    // later line overwrite the request the reader is looking at.
    if (record?.phase === 'start') operation.start ??= record;
    else if (record?.phase === 'end') operation.end ??= record;
    else if (record?.phase === 'attempt') operation.retries += 1;
  }
  return ordered;
}

/**
 * Parse an NDJSON records response line by line, stopping at `maxOperations`.
 *
 * Line-by-line and capped on purpose: the whole point of the route streaming
 * is lost if the client buffers the artifact into one string and then splits
 * it. Once the cap is hit the generator's `finally` cancels the underlying
 * read, so a 16 MiB artifact costs the tab the lines of `maxOperations`
 * operations, not 16 MiB.
 *
 * The cap admits whole operations: a line belonging to an operation already
 * admitted is always taken, so the page can never end on a `start` whose `end`
 * was cut off — which would render as a call that never came back.
 */
export async function parseRecordStream(
  response: Response,
  maxOperations: number = MAX_INLINE_OPERATIONS,
): Promise<ParsedRecords> {
  const records: RequestRecord[] = [];
  const admitted = new Set<string>();
  let malformed = 0;
  let cappedEarly = false;
  let buffer = '';

  const take = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      return true;
    }
    if (!parsed || typeof parsed !== 'object') {
      malformed += 1;
      return true;
    }
    const record = parsed as RequestRecord;
    const id = typeof record.operationId === 'string' ? record.operationId : '';
    if (!admitted.has(id)) {
      if (admitted.size >= maxOperations) {
        // A record for an operation we have no room for — and therefore proof
        // that there IS more than the cap.
        cappedEarly = true;
        return false;
      }
      admitted.add(id);
    }
    records.push(record);
    return true;
  };

  outer: for await (const chunk of textChunks(response)) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!take(line)) {
        cappedEarly = true;
        break outer;
      }
      newline = buffer.indexOf('\n');
    }
  }
  if (!cappedEarly && buffer.trim() !== '') take(buffer);

  return { records, malformed, cappedEarly };
}
