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
 * 3. **The inline viewer is capped.** See `MAX_INLINE_RECORDS`. The cap is
 *    stated in the UI, not hidden.
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
  MAX_INLINE_RECORDS,
  STATUS_EXPLANATIONS,
  formatBytes,
  hasCapturedRequests,
  hasReadableRecords,
  readDiagnostics,
  readableCounters,
  recordsFilename,
  parseRecordStream,
} from './diagnostics';
import type { ParsedRecords } from './diagnostics';
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
      `Showing the first ${MAX_INLINE_RECORDS} records. Download the .jsonl for the rest.`,
    );
  }
  if (parsed.malformed > 0) {
    notes.push(`${parsed.malformed} line(s) could not be parsed and are not shown.`);
  }
  return notes.length > 0 ? notes.join(' ') : null;
}

/** One line of the record list, expandable into the normalized request/response. */
function RecordRow({ record, index }: { record: RequestRecord; index: number }) {
  const [open, setOpen] = useState(false);
  const correlation =
    record.caseIndex !== undefined
      ? `case ${record.caseIndex}${record.scorer ? ` · ${record.scorer}` : ''}`
      : record.scorer
        ? record.scorer
        : undefined;
  const attempts = Number.isFinite(record.transportAttempts) ? record.transportAttempts : undefined;
  const totalMs = record.response?.timing?.totalMs;

  return (
    <li className="border-b border-[hsl(var(--border))] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 hover:bg-[hsl(var(--muted))]/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
      >
        <span className="flex items-baseline gap-2 flex-wrap text-[11px]">
          <span className="font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
            {record.phase}
          </span>
          <span className="font-mono text-[hsl(var(--foreground))]">{record.model}</span>
          <span className="font-mono text-[hsl(var(--muted-foreground))]">{record.kind}</span>
          {correlation && (
            <span className="text-[hsl(var(--muted-foreground))]">{correlation}</span>
          )}
          {record.turn !== undefined && (
            <span className="text-[hsl(var(--muted-foreground))]">turn {record.turn}</span>
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
          {record.termination !== undefined && (
            <span
              className="text-amber-700 dark:text-amber-300"
              title="The operation ended deliberately without a response — not a call that never came back."
            >
              terminated: {record.termination}
            </span>
          )}
          {record.error && (
            <span className="text-red-700 dark:text-red-300">error: {record.error.message}</span>
          )}
          {record.captured?.truncated && (
            <span className="text-amber-700 dark:text-amber-300">
              stub — record exceeded the size limit
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
            {totalMs !== undefined ? formatDuration(totalMs) : null}
          </span>
        </span>
        <span className="block font-mono text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
          {record.operationId}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-[11px]">
          <RecordDetail record={record} index={index} />
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

function RecordDetail({ record, index }: { record: RequestRecord; index: number }) {
  const request = record.request;
  const response = record.response;
  return (
    <div className="space-y-2" data-testid={`record-detail-${index}`}>
      {record.correction && (
        <Pre
          label={`Correction (${record.correction.stage}${
            record.correction.reason ? `: ${record.correction.reason}` : ''
          })`}
          value={record.correction.feedbackMessage}
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
          <Unknown what="The request" />
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
      ) : record.error ? (
        <Pre label="Error" value={record.error} />
      ) : (
        <Row label="Response">
          <Unknown what="The response" />
        </Row>
      )}
      {record.captured?.omitted?.length > 0 && (
        <Row label="Omitted">
          <span className="text-[hsl(var(--muted-foreground))]">
            {record.captured.omitted.join(', ')}
          </span>
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
  const records = parsed?.records;
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
          <span className={cn('font-mono text-[11px]', STATUS_TONE[status])}>
            {status} — {STATUS_EXPLANATIONS[status]}
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

      {records !== undefined && (
        <div className="border-t border-[hsl(var(--border))]">
          {viewerNote && (
            <p className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">{viewerNote}</p>
          )}
          {records.length === 0 ? (
            <p className="px-4 py-3 text-[11px] text-[hsl(var(--muted-foreground))]">
              The artifact holds no records.
            </p>
          ) : (
            <ul aria-label="Captured request records" className="divide-y-0">
              {records.map((record, i) => (
                <RecordRow
                  key={`${record.operationId}-${record.phase}-${i}`}
                  record={record}
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
