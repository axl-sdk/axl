/**
 * The captured-requests block on an eval run's detail view.
 *
 * Request capture is *diagnostics* — it exists so a reader can answer "what did
 * we actually send when this case failed?" — and it is therefore held to a
 * different standard than the accounting block next to it: accounting must
 * never overstate spend, and this must never overstate evidence. A manifest
 * that says `truncated` is missing operations, a manifest that says
 * `unavailable` has nothing behind it at all, and both must read that way
 * without the reader opening a network tab to find out.
 *
 * Three deliberate choices:
 *
 * 1. **The result's own manifest renders first, the live route corrects it.**
 *    The bytes can be swept between the moment history was fetched and the
 *    moment the reader opens the run, so availability is confirmed against
 *    `GET /api/evals/:id/diagnostics` — which is also the only place a
 *    rescore's `copiedFrom` provenance exists.
 * 2. **Nothing here reconstructs a request.** The server already redacted the
 *    stored bytes (and re-redacts on delivery under `trace.redact`); this view
 *    renders what the record contains and never re-assembles headers, provider
 *    option *values*, or credentials from anything.
 * 3. **The inline viewer is capped, in operations.** See
 *    `MAX_INLINE_OPERATIONS`. The cap is stated in the UI, not hidden, and it
 *    admits whole operations so a page never ends on a request whose response
 *    was cut off.
 *
 * Both server reads are `useQuery`s keyed on the result id rather than
 * hand-rolled `useState` + `useEffect`. That is the client's convention, and
 * here it is also the correctness argument: the detail view swaps `result`
 * without remounting this subtree, so any state not keyed to the run can render
 * one run's captured evidence under another run's heading. Per-key caching makes
 * that impossible by construction; the local view state that remains (the
 * expand toggle and the download's error) is reset in render when the id moves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchEvalDiagnostics, fetchEvalDiagnosticsRecords } from '../../lib/api';
import { cn, formatDuration } from '../../lib/utils';
import {
  MAX_INLINE_OPERATIONS,
  STATUS_EXPLANATIONS,
  formatBytes,
  groupOperations,
  hasCapturedRequests,
  hasReadableRecords,
  readDiagnostics,
  readableCounters,
  recordsFilename,
  parseRecordStream,
} from './diagnostics';
import type { CapturedOperation, ParsedRecords } from './diagnostics';
import type { DiagnosticManifest, EvalResultData, RequestRecord } from './types';

const STATUS_TONE: Record<DiagnosticManifest['status'], string> = {
  complete: 'text-[hsl(var(--muted-foreground))]',
  truncated: 'text-amber-700 dark:text-amber-300',
  interrupted: 'text-amber-700 dark:text-amber-300',
  unavailable: 'text-amber-700 dark:text-amber-300',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))] shrink-0">
        {label}
      </span>
      <span className="text-xs text-[hsl(var(--foreground))]">{children}</span>
    </div>
  );
}

/** A value the artifact did not carry. Never rendered as `0`. */
function Unknown({ what }: { what: string }) {
  return (
    <span className="text-[hsl(var(--muted-foreground))] italic" title={`${what} is not recorded`}>
      unknown
    </span>
  );
}

function download(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Deferred so the browser has a chance to start the download first — same
  // reason as `exportEntry` in EvalHistoryTable.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** What the reader must be told about the parse, or `null` when nothing. */
function describeViewerNote(parsed: ParsedRecords): string | null {
  const notes: string[] = [];
  if (parsed.cappedEarly) {
    notes.push(
      `Showing the first ${MAX_INLINE_OPERATIONS} operations. Download the .jsonl for the rest.`,
    );
  }
  if (parsed.malformed > 0) {
    notes.push(`${parsed.malformed} line(s) could not be parsed and are not shown.`);
  }
  return notes.length > 0 ? notes.join(' ') : null;
}

/**
 * The reason this operation is a stub, in the artifact's own words.
 *
 * A stub has two causes a reader must tell apart: the record exceeded
 * `maxRecordBytes`, or the request/response could not be projected at all. The
 * writer records the second on `captured.reason` and leaves it unset for the
 * first, so the size sentence is the ONLY one this build may supply itself.
 */
function stubCause(records: readonly RequestRecord[]): string | undefined {
  const stub = records.find((r) => r.captured?.truncated);
  if (!stub) return undefined;
  return stub.captured?.reason ?? 'record exceeded the size limit';
}

/** True when any line of this operation reached the reader scrubbed. */
function anyRedacted(records: readonly RequestRecord[]): boolean {
  return records.some((r) => r.captured?.redacted === true);
}

/** Everything the artifact could not represent, across the operation's lines. */
function omittedAcross(records: readonly RequestRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    for (const item of record.captured?.omitted ?? []) seen.add(item);
  }
  return [...seen];
}

/**
 * One operation of the record list, expandable into request and response.
 *
 * Rendered from the operation rather than from a line, because a line is half
 * a turn. The `start` is the only line that carries a request and the `end` is
 * the only line that carries a response, so an absent half is only ever
 * reported when the LINE that would have carried it is absent — never because
 * the line on screen structurally cannot carry it.
 */
function OperationRow({ operation, index }: { operation: CapturedOperation; index: number }) {
  const [open, setOpen] = useState(false);
  const head = operation.start ?? operation.records[0];
  const end = operation.end;
  const correlation =
    head?.caseIndex !== undefined
      ? `case ${head.caseIndex}${head.scorer ? ` · ${head.scorer}` : ''}`
      : head?.scorer
        ? head.scorer
        : undefined;
  const reported = end?.transportAttempts ?? head?.transportAttempts;
  const attempts = Number.isFinite(reported) ? reported : undefined;
  const totalMs = end?.response?.timing?.totalMs;
  const stub = stubCause(operation.records);
  // A response is missing either because the operation has no `end` line at
  // all, or because its `end` carries neither response nor error.
  const noResponse = !end || (end.response === undefined && end.error === undefined);

  return (
    <li className="border-b border-[hsl(var(--border))] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 hover:bg-[hsl(var(--muted))]/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
      >
        <span className="flex items-baseline gap-2 flex-wrap text-[11px]">
          <span className="font-mono text-[hsl(var(--foreground))]">{head?.model}</span>
          <span className="font-mono text-[hsl(var(--muted-foreground))]">{head?.kind}</span>
          {correlation && (
            <span className="text-[hsl(var(--muted-foreground))]">{correlation}</span>
          )}
          {head?.turn !== undefined && (
            <span className="text-[hsl(var(--muted-foreground))]">turn {head.turn}</span>
          )}
          <span className="text-[hsl(var(--muted-foreground))]">
            {attempts !== undefined ? (
              <>attempt {attempts}</>
            ) : (
              <>
                attempt <Unknown what="Transport attempt" />
              </>
            )}
          </span>
          {end?.termination !== undefined && (
            <span
              className="text-amber-700 dark:text-amber-300"
              title="The operation ended deliberately without a response — not a call that never came back."
            >
              terminated: {end.termination}
            </span>
          )}
          {end?.error && (
            <span className="text-red-700 dark:text-red-300">error: {end.error.message}</span>
          )}
          {noResponse && (
            <span
              className="text-amber-700 dark:text-amber-300"
              title={
                end
                  ? 'The operation was sealed without a response.'
                  : 'The artifact holds no end record for this operation.'
              }
            >
              no response recorded
            </span>
          )}
          {stub !== undefined && (
            <span className="text-amber-700 dark:text-amber-300">stub — {stub}</span>
          )}
          {anyRedacted(operation.records) && (
            <span
              className="text-[hsl(var(--muted-foreground))]"
              title="This record's content was scrubbed — when it was written, or on the way out of this deployment."
            >
              redacted
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
            {totalMs !== undefined ? formatDuration(totalMs) : null}
          </span>
        </span>
        <span className="block font-mono text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
          {operation.operationId}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-[11px]">
          <OperationDetail operation={operation} index={index} />
        </div>
      )}
    </li>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1">
        {label}
      </div>
      <pre className="overflow-x-auto rounded-md bg-[hsl(var(--muted))] p-2 font-mono text-[10px] text-[hsl(var(--foreground))] whitespace-pre-wrap break-words">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function OperationDetail({ operation, index }: { operation: CapturedOperation; index: number }) {
  const start = operation.start;
  const end = operation.end;
  const request = start?.request;
  const response = end?.response;
  const correction = operation.records.find((r) => r.correction)?.correction;
  const omitted = omittedAcross(operation.records);

  return (
    <div className="space-y-2" data-testid={`operation-detail-${index}`}>
      {correction && (
        <Pre
          label={`Correction (${correction.stage}${
            correction.reason ? `: ${correction.reason}` : ''
          })`}
          value={correction.feedbackMessage}
        />
      )}
      {request ? (
        <>
          <Pre label="Request options" value={request.options} />
          {request.providerOptionKeys && request.providerOptionKeys.length > 0 && (
            <Row label="Provider option keys">
              <span
                className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]"
                title="Keys only — Axl never stores providerOptions values, which can carry credentials."
              >
                {request.providerOptionKeys.join(', ')}
              </span>
            </Row>
          )}
          {request.tools && request.tools.length > 0 && (
            <Row label="Tools">
              <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                {request.tools.map((t) => t.name).join(', ')}
              </span>
            </Row>
          )}
          <Pre label="Messages" value={request.messages} />
        </>
      ) : (
        <Row label="Request">
          {start ? (
            <Unknown what="The request" />
          ) : (
            <span className="text-[hsl(var(--muted-foreground))]">
              no start record — the artifact does not hold this operation’s request
            </span>
          )}
        </Row>
      )}
      {response ? (
        <>
          <Pre label="Response" value={response.content} />
          <Row label="Usage">
            {response.usage ? (
              <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                {JSON.stringify(response.usage)}
              </span>
            ) : (
              <Unknown what="Usage" />
            )}
          </Row>
        </>
      ) : end?.error ? (
        <Pre label="Error" value={end.error} />
      ) : (
        <Row label="Response">
          <span className="text-[hsl(var(--muted-foreground))]">
            no response recorded
            {end?.termination !== undefined
              ? ` — the operation was terminated: ${end.termination}`
              : end
                ? ' — the operation was sealed without one'
                : ' — the artifact holds no end record for this operation'}
          </span>
        </Row>
      )}
      {operation.retries > 0 && (
        <Row label="Transport retries">
          <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
            {operation.retries}
          </span>
        </Row>
      )}
      {omitted.length > 0 && (
        <Row label="Omitted">
          <span className="text-[hsl(var(--muted-foreground))]">{omitted.join(', ')}</span>
        </Row>
      )}
    </div>
  );
}

export function RunDiagnosticsPanel({
  result,
  evalName,
}: {
  result: EvalResultData;
  /** The history entry's eval name, used only for the download filename. */
  evalName?: string;
}) {
  const embedded = readDiagnostics(result);
  const resultId = result.id;
  // A multi-run aggregate is `buildMultiRunResult`'s output, which spreads run
  // 1 — `diagnostics` included. One run's artifact is not the group's evidence,
  // and its download would serve run 1's records under a group heading.
  const isAggregate = result._multiRun !== undefined;
  const embeddedReadable = !isAggregate && hasReadableRecords(embedded);

  // View state that is not server data. Reset in render (not in an effect) when
  // the panel is handed a different run, so no frame ever shows run A's
  // expansion state or download error under run B.
  const [shownFor, setShownFor] = useState(resultId);
  const [showRecords, setShowRecords] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (shownFor !== resultId) {
    setShownFor(resultId);
    setShowRecords(false);
    setDownloading(false);
    setError(null);
  }

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Confirm the bytes are still there — and pick up `copiedFrom`, which the
  // embedded manifest does not carry. Keyed on the run: a cached answer can
  // only ever be answered about the run it was fetched for.
  const availability = useQuery({
    queryKey: ['eval-diagnostics', resultId],
    queryFn: () => fetchEvalDiagnostics(resultId),
    enabled: embeddedReadable,
    retry: false,
  });

  const recordsQuery = useQuery({
    queryKey: ['eval-diagnostics-records', resultId],
    queryFn: async () => parseRecordStream(await fetchEvalDiagnosticsRecords(resultId)),
    enabled: showRecords && embeddedReadable,
    retry: false,
  });

  const onDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetchEvalDiagnosticsRecords(resultId);
      const text = await res.text();
      download(text, recordsFilename(evalName, resultId));
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setDownloading(false);
    }
  }, [resultId, evalName]);

  const onToggleRecords = useCallback(() => {
    setError(null);
    setShowRecords((v) => !v);
  }, []);

  // A run that captured nothing — and every artifact written before capture
  // existed — says nothing at all. An empty block would imply the feature was
  // on and produced nothing.
  if (!embedded || isAggregate) return null;

  const probe = availability.data;
  const liveManifest = probe?.ok ? probe.manifest : undefined;
  const gone = probe?.ok === false && probe.gone;
  const probeFailure = probe?.ok === false && !probe.gone ? probe.message : undefined;
  const parsed = showRecords ? recordsQuery.data : undefined;
  // One row per OPERATION, reassembled from its phase lines.
  const operations = parsed ? groupOperations(parsed.records) : undefined;
  const viewerNote = parsed ? describeViewerNote(parsed) : null;
  const recordsError =
    showRecords && recordsQuery.error instanceof Error ? recordsQuery.error.message : null;
  const busy = downloading || (showRecords && recordsQuery.isFetching);
  const shownError = error ?? recordsError;
  const status: DiagnosticManifest['status'] = gone
    ? 'unavailable'
    : (liveManifest?.status ?? embedded.status);
  const reason = gone
    ? probe?.ok === false
      ? probe.message
      : undefined
    : (liveManifest?.reason ?? embedded.reason);
  const readable =
    !gone && hasReadableRecords({ ...embedded, status, artifactId: embedded.artifactId });
  const counters = readable
    ? readableCounters({
        ...embedded,
        status,
        records: liveManifest?.records ?? embedded.records,
        bytes: liveManifest?.bytes ?? embedded.bytes,
      })
    : { records: undefined, bytes: undefined };
  const expiresAt = liveManifest?.expiresAt ?? embedded.expiresAt;
  const redaction = liveManifest?.redaction ?? embedded.redaction;
  const fidelity = liveManifest?.fidelity ?? embedded.fidelity;
  const copiedFrom = liveManifest?.copiedFrom;
  const explanation: string | undefined = STATUS_EXPLANATIONS[status];
  // Under `trace.redact` the server re-scrubs an artifact on the way out, so
  // records can read `[REDACTED]` while the manifest correctly says the STORED
  // bytes are not. Saying only the second leaves the reader unable to tell
  // whether anything is recoverable from disk.
  const deliveryRedacted =
    redaction === 'none' && (operations?.some((op) => anyRedacted(op.records)) ?? false);

  return (
    <section
      aria-labelledby={`captured-requests-${resultId}`}
      className="rounded-xl border border-[hsl(var(--border))] overflow-hidden"
    >
      <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))] flex items-center justify-between gap-3">
        <h3
          id={`captured-requests-${resultId}`}
          className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]"
        >
          Captured requests
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onToggleRecords()}
            disabled={!readable || busy}
            className="text-[11px] px-2 py-1 rounded-md border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {showRecords ? 'Hide captured records' : 'Show captured records'}
          </button>
          <button
            type="button"
            onClick={() => void onDownload()}
            disabled={!readable || busy}
            className="text-[11px] px-2 py-1 rounded-md border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Download records (.jsonl)
          </button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2">
        <Row label="Status">
          <span
            className={cn(
              'font-mono text-[11px]',
              STATUS_TONE[status] ?? 'text-amber-700 dark:text-amber-300',
            )}
          >
            {/* A manifest written by a later build can carry a status this one
                does not know. Naming it alone is honest; appending an empty
                explanation after a dash is not. */}
            {explanation === undefined ? status : `${status} — ${explanation}`}
          </span>
        </Row>
        {reason && (
          <Row label="Reason">
            <span className="text-[hsl(var(--muted-foreground))]">{reason}</span>
          </Row>
        )}
        <Row label="Records">
          {counters.records !== undefined ? (
            <span className="font-mono tabular-nums text-[hsl(var(--muted-foreground))]">
              {counters.records}
            </span>
          ) : (
            <Unknown what="The record count" />
          )}
          <span className="ml-2 text-[hsl(var(--muted-foreground))]">
            {counters.bytes !== undefined ? formatBytes(counters.bytes) : <Unknown what="Size" />}
          </span>
        </Row>
        <Row label="Fidelity">
          <span className="font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
            {fidelity}
          </span>
        </Row>
        <Row label="Redaction">
          <span className="text-[hsl(var(--muted-foreground))]">
            {redaction === 'applied'
              ? 'applied — the stored bytes are redacted'
              : 'none — the stored bytes are NOT redacted'}
          </span>
        </Row>
        <Row label="Expires">
          {expiresAt !== undefined && Number.isFinite(expiresAt) ? (
            <span className="text-[hsl(var(--muted-foreground))]">
              {new Date(expiresAt).toLocaleString()}
            </span>
          ) : (
            <span className="text-[hsl(var(--muted-foreground))]">no expiry recorded</span>
          )}
        </Row>
        {copiedFrom && (
          <Row label="Copied from">
            <span
              className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]"
              title="This artifact was copied from the run this one rescored; the copied records keep their original operation ids."
            >
              artifact {copiedFrom.artifactId} (run {copiedFrom.ownerId})
            </span>
          </Row>
        )}
        {probeFailure !== undefined && (
          <Row label="Note">
            <span className="text-amber-700 dark:text-amber-300">
              could not confirm the artifact is still stored: {probeFailure}
            </span>
          </Row>
        )}
        {shownError && (
          <Row label="Error">
            <span className="text-red-700 dark:text-red-300">{shownError}</span>
          </Row>
        )}
      </div>

      {operations !== undefined && (
        <div className="border-t border-[hsl(var(--border))]">
          {viewerNote && (
            <p className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">{viewerNote}</p>
          )}
          {deliveryRedacted && (
            <p className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              Delivered redacted by this deployment&rsquo;s trace.redact; the stored bytes are not.
            </p>
          )}
          {operations.length === 0 ? (
            <p className="px-4 py-3 text-[11px] text-[hsl(var(--muted-foreground))]">
              The artifact holds no records.
            </p>
          ) : (
            <ul aria-label="Captured request records" className="divide-y-0">
              {operations.map((operation, i) => (
                <OperationRow
                  key={`${operation.operationId}-${i}`}
                  operation={operation}
                  index={i}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** A scannable marker that a history row's run carries captured requests. */
export function CapturedRequestsBadge({ result }: { result: EvalResultData }) {
  if (!hasCapturedRequests(result)) return null;
  const manifest = readDiagnostics(result);
  return (
    <span
      aria-label="Captured requests available"
      title={`${manifest?.records} captured request record(s) — open the run to inspect or download them.`}
      className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-medium uppercase tracking-wide bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200"
    >
      requests
    </span>
  );
}
