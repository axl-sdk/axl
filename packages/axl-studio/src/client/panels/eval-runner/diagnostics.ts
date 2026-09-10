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
 * How many records the inline viewer holds.
 *
 * An artifact is allowed to be 16 MiB across tens of thousands of records, and
 * a browser tab that parses all of them into React state to render a list is
 * how a diagnostics read takes the page down. The cap is deliberately a
 * *reader* bound, not a fetch bound: the stream is cancelled once the cap is
 * reached, so the client never holds more than this many records regardless of
 * how large the artifact is. Anything past it is the download's job.
 */
export const MAX_INLINE_RECORDS = 200;

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
  /** True when parsing stopped at `maxRecords` with body left unread. */
  cappedEarly: boolean;
};

/**
 * Parse an NDJSON records response line by line, stopping at `maxRecords`.
 *
 * Line-by-line and capped on purpose: the whole point of the route streaming
 * is lost if the client buffers the artifact into one string and then splits
 * it. Once the cap is hit the generator's `finally` cancels the underlying
 * read, so a 16 MiB artifact costs the tab `maxRecords` objects, not 16 MiB.
 */
export async function parseRecordStream(
  response: Response,
  maxRecords: number = MAX_INLINE_RECORDS,
): Promise<ParsedRecords> {
  const records: RequestRecord[] = [];
  let malformed = 0;
  let cappedEarly = false;
  let buffer = '';

  const take = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed as RequestRecord);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
    return records.length < maxRecords;
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
