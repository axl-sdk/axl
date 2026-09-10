// @vitest-environment jsdom
/**
 * Studio client presentation of a run's captured requests.
 *
 * Every case here kills one specific wrong rendering: a downgraded manifest
 * that still advertises 137 records, an "unavailable" block that still offers a
 * download, a legacy run growing an empty diagnostics box, an inline viewer
 * that quietly drops records past its cap, and a redaction label that leaves
 * the reader guessing whether the bytes on disk are scrubbed.
 *
 * Test-matrix rows: A16.19–A16.39 (P5b), plus A16.40–A16.42 for the per-phase
 * stub reading and the cap's retention semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import {
  RunDiagnosticsPanel,
  CapturedRequestsBadge,
} from '../client/panels/eval-runner/RunDiagnosticsPanel';
import { EvalHistoryTable } from '../client/panels/eval-runner/EvalHistoryTable';
import {
  MAX_INLINE_OPERATIONS,
  groupOperations,
  parseRecordStream,
  recordsFilename,
} from '../client/panels/eval-runner/diagnostics';
import type { EvalHistoryEntry } from '../client/lib/types';
import type {
  CapturedMessage,
  DiagnosticManifest,
  EvalResultData,
  RequestRecord,
} from '../client/panels/eval-runner/types';

// ── Fixtures ─────────────────────────────────────────────────────

const RESULT_ID = 'run-abc-123';

function manifest(overrides: Partial<DiagnosticManifest> = {}): DiagnosticManifest {
  return {
    version: 1,
    artifactId: 'artifact-1',
    fidelity: 'runtime_request',
    status: 'complete',
    records: 3,
    bytes: 4096,
    redaction: 'none',
    ...overrides,
  };
}

function result(diagnostics?: DiagnosticManifest, id: string = RESULT_ID): EvalResultData {
  return {
    id,
    dataset: 'qa-dataset',
    timestamp: new Date(0).toISOString(),
    totalCost: 0,
    duration: 100,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * The record fixtures are codec-faithful on purpose.
 *
 * The artifact is one JSONL line per PHASE, and the phases carry disjoint
 * halves of a call: `scoped-provider.ts` emits `start` with the request only,
 * `attempt` with neither, and `end` with the response / error / termination
 * only. A fixture that puts a request and a response on one line is a shape
 * the writer cannot emit, and a viewer tested only against it never has to
 * reassemble anything.
 */
function baseRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    v: 1,
    phase: 'start',
    operationId: 'op-1',
    kind: 'chat',
    caseIndex: 0,
    transportAttempts: 1,
    provider: 'openai',
    model: 'gpt-5-mini',
    captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
    ...overrides,
  };
}

/** A `start` line: the request, and nothing about how the call ended. */
function startRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return baseRecord({
    phase: 'start',
    request: {
      messages: [{ role: 'user', content: 'what is 2+2?' }],
      options: { model: 'gpt-5-mini', temperature: 0 },
      providerOptionKeys: ['organization'],
    },
    ...overrides,
  });
}

/** An `end` line: the response (or error / termination), and no request. */
function endRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return baseRecord({
    phase: 'end',
    response: {
      content: '4',
      usage: { inputTokens: 8, outputTokens: 1 },
      timing: { totalMs: 120 },
    },
    ...overrides,
  });
}

/** The two lines one ordinary completed operation writes. */
function operationLines(overrides: Partial<RequestRecord> = {}): RequestRecord[] {
  return [startRecord(overrides), endRecord(overrides)];
}

/**
 * The client `CapturedMessage.tool_calls` mirror must match core's
 * `ToolCallMessage` — `{ id, type: 'function', function: { name, arguments } }`,
 * which is the shape `redactCapturedRequest` reaches into. A flattened mirror
 * type-checks against nothing and hands the next reader `undefined` for
 * `call.name` with no error. Compile-time only; `tsc` is the assertion.
 */
function describeToolCall(call: NonNullable<CapturedMessage['tool_calls']>[number]): string {
  return `${call.id} → ${call.function.name}(${call.function.arguments})`;
}

// ── Fetch routing ────────────────────────────────────────────────

type Routes = {
  manifest?: { status: number; body: unknown };
  records?: string;
  /** Throw from `fetch` itself — a network failure on the availability probe. */
  networkError?: string;
};

let calls: string[] = [];

/** The history id in `/api/evals/<id>/diagnostics[/records]`. */
function idFromUrl(url: string): string {
  return /\/evals\/([^/]+)\/diagnostics/.exec(url)?.[1] ?? '';
}

/**
 * Route `fetch` by URL, optionally per result id.
 *
 * Per-id routing is what makes the "switch runs on a mounted panel" cases
 * meaningful: run B must be able to answer differently from run A.
 */
function stubFetch(fallback: Routes, byId: Record<string, Routes> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const routes = byId[decodeURIComponent(idFromUrl(url))] ?? fallback;
    if (routes.networkError !== undefined) {
      return Promise.reject(new Error(routes.networkError));
    }
    if (url.endsWith('/diagnostics/records')) {
      if (routes.records === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(routes.records, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        }),
      );
    }
    if (url.endsWith('/diagnostics')) {
      const route = routes.manifest ?? { status: 200, body: { ok: true, data: manifest() } };
      return Promise.resolve(
        new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ndjson(records: RequestRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Render inside a fresh `QueryClient`, as the app does.
 *
 * A per-test client is what keeps one case's cached manifest out of the next
 * one; `retry: false` keeps a 404 from being retried for the length of the test.
 */
function renderPanel(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // `wrapper` is remembered by `rerender`, so switching the panel's `result`
  // keeps the same client — which is the point: a per-run cache must isolate
  // the runs, not a fresh provider.
  return render(node, { wrapper });
}

let clicked: Array<{ download: string; href: string }> = [];
/** Every blob handed to `URL.createObjectURL` — i.e. what the user would save. */
let blobs: Blob[] = [];

beforeEach(() => {
  calls = [];
  clicked = [];
  blobs = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock';
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ download: this.download, href: this.href });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Cases ────────────────────────────────────────────────────────

describe('RunDiagnosticsPanel', () => {
  it('A16.19 renders a complete manifest with counts, fidelity and a plain redaction statement', async () => {
    stubFetch({
      manifest: {
        status: 200,
        body: { ok: true, data: { ...manifest(), records: 12, bytes: 2048, redaction: 'applied' } },
      },
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

    expect(screen.getByRole('heading', { name: 'Captured requests' })).toBeInTheDocument();
    expect(
      screen.getByText(/complete — every dispatched operation was captured/),
    ).toBeInTheDocument();
    await screen.findByText('12');
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('runtime_request')).toBeInTheDocument();
    // The reader must not have to infer what `applied` refers to.
    expect(screen.getByText('applied — the stored bytes are redacted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeEnabled();
  });

  it('A16.20 renders a truncated manifest with its reason and keeps download enabled', async () => {
    const truncated = manifest({
      status: 'truncated',
      reason: 'run byte limit reached after the rescore copy',
    });
    stubFetch({ manifest: { status: 200, body: { ok: true, data: truncated } } });

    renderPanel(<RunDiagnosticsPanel result={result(truncated)} evalName="qa-eval" />);

    expect(
      screen.getByText(/truncated — capture stopped at a size limit — some operations are missing/),
    ).toBeInTheDocument();
    expect(screen.getByText('run byte limit reached after the rescore copy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeEnabled();
    // Let the live-availability check settle inside the test.
    await waitFor(() => expect(calls.some((u) => u.endsWith('/diagnostics'))).toBe(true));
    await screen.findByText('4.0 KB');
  });

  it('A16.21 renders an unavailable manifest with its reason, no record count, and a disabled download', async () => {
    // A result persisted by an older build can still carry the pre-downgrade
    // counters. The block must not repeat them as fact.
    const gone = manifest({
      artifactId: '',
      status: 'unavailable',
      reason: 'the captured-request artifact for this result is no longer available',
      records: 137,
      bytes: 2_100_000,
    });
    const fetchMock = stubFetch({});

    renderPanel(<RunDiagnosticsPanel result={result(gone)} evalName="qa-eval" />);

    expect(screen.getByText(/unavailable — the captured bytes are not stored/)).toBeInTheDocument();
    expect(
      screen.getByText('the captured-request artifact for this result is no longer available'),
    ).toBeInTheDocument();
    expect(screen.queryByText('137')).not.toBeInTheDocument();
    expect(screen.queryByText('2.0 MB')).not.toBeInTheDocument();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show captured records' })).toBeDisabled();
    // An artifact this result does not own must not be probed for.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('A16.22 renders nothing for a legacy result with no diagnostics', () => {
    stubFetch({});
    const { container } = renderPanel(<RunDiagnosticsPanel result={result()} evalName="qa-eval" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('A16.23 downgrades to unavailable when the artifact was swept after the result loaded', async () => {
    stubFetch({
      manifest: {
        status: 404,
        body: {
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Captured requests are no longer available' },
        },
      },
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

    await screen.findByText(/unavailable — the captured bytes are not stored/);
    expect(screen.getByText('Captured requests are no longer available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeDisabled();
  });

  it('A16.24 downloads the records route once, names the file, and saves the artifact bytes', async () => {
    const user = userEvent.setup();
    const body = ndjson(operationLines());
    const fetchMock = stubFetch({ records: body });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa eval" />);
    await waitFor(() => expect(calls.some((u) => u.endsWith('/diagnostics'))).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Download records (.jsonl)' }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe(`qa-eval-${RESULT_ID}.requests.jsonl`);
    expect(recordsFilename('qa eval', RESULT_ID)).toBe(`qa-eval-${RESULT_ID}.requests.jsonl`);
    const recordCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/diagnostics/records'),
    );
    expect(recordCalls).toHaveLength(1);
    // The saved file is the artifact, not a name and an empty blob: assert the
    // bytes handed to `createObjectURL` round-trip to the records on the wire.
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/x-ndjson');
    await expect(blobs[0].text()).resolves.toBe(body);
  });

  it('A16.25 renders one operation as one row carrying both its request and its response', async () => {
    const user = userEvent.setup();
    stubFetch({
      records: ndjson([
        startRecord({ operationId: 'op-answered', caseIndex: 4, scorer: 'llm-judge' }),
        endRecord({
          operationId: 'op-answered',
          caseIndex: 4,
          scorer: 'llm-judge',
          transportAttempts: 2,
        }),
      ]),
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    // One turn is one row, not a request row and an orphan response row.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText(/case 4 · llm-judge/)).toBeInTheDocument();
    expect(within(list).getByText(/attempt 2/)).toBeInTheDocument();
    expect(within(list).getByText('op-answered')).toBeInTheDocument();
    // A completed call is never described as one whose response is missing.
    expect(within(list).queryByText(/no response recorded/)).not.toBeInTheDocument();

    await user.click(within(list).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('operation-detail-0');
    expect(within(detail).getByText(/what is 2\+2\?/)).toBeInTheDocument();
    expect(within(detail).getByText(/"inputTokens": 8|inputTokens/)).toBeInTheDocument();
    // Neither half of the turn claims the other is unrecorded.
    expect(within(detail).queryByText('unknown')).not.toBeInTheDocument();
  });

  it('A16.25b reports a start with no end as no response recorded, and names a termination', async () => {
    const user = userEvent.setup();
    stubFetch({
      records: ndjson([
        // A genuinely hung call: the artifact holds its request and nothing else.
        startRecord({ operationId: 'op-hung', caseIndex: 1 }),
        // A deliberately ended one: sealed by an `end` that carries a reason.
        startRecord({ operationId: 'op-stalled', caseIndex: 2 }),
        endRecord({
          operationId: 'op-stalled',
          caseIndex: 2,
          response: undefined,
          termination: 'stream_stall_timeout',
        }),
      ]),
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/no response recorded/)).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/terminated:/)).not.toBeInTheDocument();
    // The stalled one is NOT a call that never came back — the reason says so.
    expect(within(rows[1]).getByText(/terminated: stream_stall_timeout/)).toBeInTheDocument();

    await user.click(within(rows[0]).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('operation-detail-0');
    expect(within(detail).getByText(/what is 2\+2\?/)).toBeInTheDocument();
    expect(
      within(detail).getByText(/no response recorded — the artifact holds no end record/),
    ).toBeInTheDocument();
  });

  it('A16.26 caps the inline viewer at whole operations and says so', async () => {
    const user = userEvent.setup();
    // Two lines per operation: a cap counted in lines would show half of these.
    const many = Array.from({ length: MAX_INLINE_OPERATIONS + 25 }, (_, i) =>
      operationLines({ operationId: `op-${i}`, caseIndex: i }),
    ).flat();
    stubFetch({ records: ndjson(many) });

    renderPanel(
      <RunDiagnosticsPanel
        result={result(manifest({ records: many.length }))}
        evalName="qa-eval"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(MAX_INLINE_OPERATIONS);
    // Every admitted operation is whole — none of them lost its `end` to the cap.
    expect(within(list).queryByText(/no response recorded/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `Showing the first ${MAX_INLINE_OPERATIONS} operations. Download the .jsonl for the rest.`,
      ),
    ).toBeInTheDocument();
  });

  it('A16.26b does not claim there is more when the artifact holds exactly the cap', async () => {
    const user = userEvent.setup();
    const exact = Array.from({ length: MAX_INLINE_OPERATIONS }, (_, i) =>
      operationLines({ operationId: `op-${i}`, caseIndex: i }),
    ).flat();
    stubFetch({ records: ndjson(exact) });

    renderPanel(
      <RunDiagnosticsPanel
        result={result(manifest({ records: exact.length }))}
        evalName="qa-eval"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(MAX_INLINE_OPERATIONS);
    // There is no rest. Saying there is tells the reader evidence is missing
    // that is in fact on screen.
    expect(screen.queryByText(/Download the .jsonl for the rest/)).not.toBeInTheDocument();
  });

  it('A16.26c keeps admitted operations whole when the artifact interleaves them', async () => {
    const user = userEvent.setup();
    // The eval runner runs cases concurrently (default 5), so an operation's
    // `end` lands several `start`s after its own. A16.26's strictly sequential
    // fixture cannot see a reader that stops at the first line past the cap:
    // this one can, because the last few admitted operations only get their
    // `end` after the cap has already been exceeded.
    const total = MAX_INLINE_OPERATIONS + 25;
    const lag = 5;
    const lines: RequestRecord[] = [];
    for (let i = 0; i < total; i += 1) {
      lines.push(startRecord({ operationId: `op-${i}`, caseIndex: i }));
      if (i >= lag) lines.push(endRecord({ operationId: `op-${i - lag}`, caseIndex: i - lag }));
    }
    for (let i = total - lag; i < total; i += 1) {
      lines.push(endRecord({ operationId: `op-${i}`, caseIndex: i }));
    }
    stubFetch({ records: ndjson(lines) });

    renderPanel(
      <RunDiagnosticsPanel
        result={result(manifest({ records: lines.length }))}
        evalName="qa-eval"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(MAX_INLINE_OPERATIONS);
    // Every admitted operation's `end` IS in the artifact. Saying otherwise
    // describes a completed call as one that never came back.
    expect(within(list).queryAllByText(/no response recorded/)).toHaveLength(0);
    expect(
      screen.getByText(
        `Showing the first ${MAX_INLINE_OPERATIONS} operations. Download the .jsonl for the rest.`,
      ),
    ).toBeInTheDocument();
  });

  it('A16.27 shows a rescore copy provenance from the live manifest', async () => {
    stubFetch({
      manifest: {
        status: 200,
        body: {
          ok: true,
          data: { ...manifest(), copiedFrom: { artifactId: 'artifact-src', ownerId: 'run-src' } },
        },
      },
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

    expect(await screen.findByText('artifact artifact-src (run run-src)')).toBeInTheDocument();
  });

  it('A16.30 drops one run’s captured records when the panel switches to another run', async () => {
    const user = userEvent.setup();
    const OTHER_ID = 'run-def-456';
    stubFetch(
      {},
      {
        [RESULT_ID]: { records: ndjson(operationLines({ operationId: 'op-run-a' })) },
        [OTHER_ID]: { records: ndjson(operationLines({ operationId: 'op-run-b' })) },
      },
    );

    const { rerender } = renderPanel(
      <RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));
    expect(await screen.findByText('op-run-a')).toBeInTheDocument();

    rerender(<RunDiagnosticsPanel result={result(manifest(), OTHER_ID)} evalName="qa-eval" />);

    // Run A's evidence may never be rendered under run B's heading, not even
    // for a frame while B loads.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Captured requests' })).toBeInTheDocument(),
    );
    expect(screen.queryByText('op-run-a')).not.toBeInTheDocument();
  });

  it('A16.31 disables both actions and drops the previous run’s counters when the next run has no artifact', async () => {
    const OTHER_ID = 'run-gone-789';
    stubFetch(
      {},
      {
        [RESULT_ID]: {
          manifest: {
            status: 200,
            body: { ok: true, data: { ...manifest(), records: 12, bytes: 2048 } },
          },
        },
      },
    );

    const { rerender } = renderPanel(
      <RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />,
    );
    await screen.findByText('12');

    const gone = manifest({
      artifactId: '',
      status: 'unavailable',
      records: 137,
      bytes: 2_100_000,
    });
    rerender(<RunDiagnosticsPanel result={result(gone, OTHER_ID)} evalName="qa-eval" />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Show captured records' })).toBeDisabled();
    expect(screen.getByText(/unavailable — the captured bytes are not stored/)).toBeInTheDocument();
    // Neither run A's live counters nor run B's stale pre-downgrade ones.
    expect(screen.queryByText('12')).not.toBeInTheDocument();
    expect(screen.queryByText('2.0 KB')).not.toBeInTheDocument();
    expect(screen.queryByText('137')).not.toBeInTheDocument();
  });

  it('A16.32 renders nothing for a multi-run aggregate result', () => {
    stubFetch({});
    // `buildMultiRunResult` spreads run 1 — including its `diagnostics` — into
    // the aggregate. Rendering the block there would present one run's captured
    // requests as the whole group's.
    const runOne = result(manifest({ records: 6 }), 'run-1');
    const aggregate: EvalResultData = {
      ...runOne,
      _multiRun: {
        aggregate: { runGroupId: 'group-1', runCount: 2, scorers: {} },
        allRuns: [runOne, result(undefined, 'run-2')],
      },
    };

    const { container } = renderPanel(
      <RunDiagnosticsPanel result={aggregate} evalName="qa-eval" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('A16.33 names a stub’s real cause instead of always blaming the size limit', async () => {
    const user = userEvent.setup();
    stubFetch({
      records: ndjson([
        // Could not be projected at all — the writer says why on `captured.reason`.
        baseRecord({
          operationId: 'op-unprojectable',
          caseIndex: 0,
          captured: {
            fidelity: 'runtime_request',
            redacted: false,
            truncated: true,
            omitted: ['record'],
            reason: 'a response could not be captured: DataCloneError',
          },
        }),
        // Over `maxRecordBytes` — no reason, and the replaced size on `bytes`.
        baseRecord({
          operationId: 'op-oversize',
          caseIndex: 1,
          bytes: 400_000,
          captured: {
            fidelity: 'runtime_request',
            redacted: false,
            truncated: true,
            omitted: ['record'],
          },
        }),
      ]),
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    const rows = within(list).getAllByRole('listitem');
    expect(
      within(rows[0]).getByText(/stub — a response could not be captured: DataCloneError/),
    ).toBeInTheDocument();
    // The projection failure must not be reported as an over-size record.
    expect(within(rows[0]).queryByText(/exceeded the size limit/)).not.toBeInTheDocument();
    expect(
      within(rows[1]).getByText(/request stub — record exceeded the size limit/),
    ).toBeInTheDocument();
  });

  it('A16.40 reads a stub per phase — a stubbed request never hides a missing response', async () => {
    const user = userEvent.setup();
    stubFetch({
      records: ndjson([
        // The likeliest oversize record is the REQUEST (prompts are big). This
        // operation then hangs: the artifact holds no `end` at all. Both facts
        // are true and the row has to carry both.
        startRecord({
          operationId: 'op-req-stub-hung',
          caseIndex: 0,
          request: undefined,
          captured: {
            fidelity: 'runtime_request',
            redacted: false,
            truncated: true,
            omitted: ['record'],
          },
        }),
        // A response that could not be projected: the `end` line is the stub,
        // so "no response recorded" WOULD be the wrong reading here.
        startRecord({ operationId: 'op-res-stub', caseIndex: 1 }),
        endRecord({
          operationId: 'op-res-stub',
          caseIndex: 1,
          response: undefined,
          captured: {
            fidelity: 'runtime_request',
            redacted: false,
            truncated: true,
            omitted: ['record'],
            reason: 'a response could not be captured: DataCloneError',
          },
        }),
      ]),
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // Request stubbed AND no end in the artifact — the row states both.
    expect(
      within(rows[0]).getByText(/request stub — record exceeded the size limit/),
    ).toBeInTheDocument();
    expect(within(rows[0]).getByText(/no response recorded/)).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/response stub/)).not.toBeInTheDocument();

    // Response stubbed — that IS why the response is missing, so the row must
    // not additionally read as a call that never came back.
    expect(
      within(rows[1]).getByText(/response stub — a response could not be captured: DataCloneError/),
    ).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/no response recorded/)).not.toBeInTheDocument();
    expect(within(rows[1]).queryByText(/request stub/)).not.toBeInTheDocument();

    await user.click(within(rows[0]).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('operation-detail-0');
    expect(
      within(detail).getByText(
        /the record was replaced by a stub — record exceeded the size limit/,
      ),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/no response recorded — the artifact holds no end record/),
    ).toBeInTheDocument();
  });

  it('A16.34 tells stored redaction apart from redaction applied on delivery', async () => {
    const user = userEvent.setup();
    stubFetch({
      // The manifest is about the STORED bytes and says they are not scrubbed.
      manifest: { status: 200, body: { ok: true, data: { ...manifest(), redaction: 'none' } } },
      records: ndjson([
        startRecord({
          operationId: 'op-scrubbed',
          request: {
            messages: [{ role: 'user', content: '[REDACTED]' }],
            options: { model: 'gpt-5-mini' },
          },
          captured: {
            fidelity: 'runtime_request',
            redacted: true,
            truncated: false,
            omitted: [],
          },
        }),
        endRecord({
          operationId: 'op-scrubbed',
          captured: {
            fidelity: 'runtime_request',
            redacted: true,
            truncated: false,
            omitted: [],
          },
        }),
      ]),
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));
    await screen.findByRole('list', { name: 'Captured request records' });

    // Both facts, because a reader seeing `[REDACTED]` under a "not redacted"
    // header cannot otherwise tell whether the bytes on disk are recoverable.
    expect(screen.getByText('none — the stored bytes are NOT redacted')).toBeInTheDocument();
    expect(screen.getByText(/delivered redacted by this deployment/i)).toBeInTheDocument();
  });

  it('A16.35 renders a status this build does not know without a dangling separator', async () => {
    stubFetch({});
    const future = {
      ...manifest(),
      status: 'quarantined',
    } as unknown as DiagnosticManifest;

    renderPanel(<RunDiagnosticsPanel result={result(future)} evalName="qa-eval" />);

    const statusText = await screen.findByText(/quarantined/);
    expect(statusText.textContent).toBe('quarantined');
  });

  it('A16.36 keeps the embedded counters and says so when availability cannot be confirmed', async () => {
    stubFetch({ networkError: 'Failed to fetch' });

    renderPanel(
      <RunDiagnosticsPanel result={result(manifest({ records: 6 }))} evalName="qa-eval" />,
    );

    expect(
      await screen.findByText(/could not confirm the artifact is still stored: Failed to fetch/),
    ).toBeInTheDocument();
    // A probe that failed is not evidence the artifact is gone.
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeEnabled();
  });

  it('A16.37 reports an unparseable line without rendering it', async () => {
    const user = userEvent.setup();
    const [start, end] = operationLines({ operationId: 'op-ok' });
    stubFetch({
      records: `${JSON.stringify(start)}\n{"v":1,"operationId":"op-bad"\n${JSON.stringify(end)}\n`,
    });

    renderPanel(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.getByText('1 line(s) could not be parsed and are not shown.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/op-bad/)).not.toBeInTheDocument();
  });

  it('A16.39 mirrors core’s ToolCallMessage shape for a captured tool call', () => {
    expect(
      describeToolCall({
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"axl"}' },
      }),
    ).toBe('call_1 → lookup({"q":"axl"})');
  });

  it('A16.38 states plainly that a complete artifact holds no records', async () => {
    const user = userEvent.setup();
    stubFetch({
      manifest: { status: 200, body: { ok: true, data: { ...manifest(), records: 0, bytes: 0 } } },
      records: '',
    });

    renderPanel(
      <RunDiagnosticsPanel result={result(manifest({ records: 0 }))} evalName="qa-eval" />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    expect(await screen.findByText('The artifact holds no records.')).toBeInTheDocument();
    // Nothing was cut off and nothing failed to parse.
    expect(screen.queryByText(/could not be parsed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Download the .jsonl for the rest/)).not.toBeInTheDocument();
  });
});

describe('CapturedRequestsBadge', () => {
  it('A16.28 marks a history row that carries readable records, and only that row', () => {
    const { container: withRecords } = render(
      <CapturedRequestsBadge result={result(manifest({ records: 5 }))} />,
    );
    expect(within(withRecords).getByLabelText('Captured requests available')).toBeInTheDocument();

    const { container: empty } = render(
      <CapturedRequestsBadge result={result(manifest({ records: 0 }))} />,
    );
    expect(empty).toBeEmptyDOMElement();

    const { container: gone } = render(
      <CapturedRequestsBadge
        result={result(manifest({ status: 'unavailable', artifactId: '', records: 9 }))}
      />,
    );
    expect(gone).toBeEmptyDOMElement();

    const { container: legacy } = render(<CapturedRequestsBadge result={result()} />);
    expect(legacy).toBeEmptyDOMElement();
  });

  it('A16.29 reaches the history table — one row carries the indicator', () => {
    const history: EvalHistoryEntry[] = [
      { id: 'with', eval: 'qa-eval', timestamp: 1, data: result(manifest({ records: 5 })) },
      { id: 'without', eval: 'qa-eval', timestamp: 2, data: result() },
    ];
    render(
      <EvalHistoryTable
        history={history}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    expect(screen.getAllByLabelText('Captured requests available')).toHaveLength(1);
  });
});

/**
 * The reader's cap, at the unit the panel cannot reach cheaply.
 *
 * `maxOperations` is a parameter precisely so these cases can state the cap in
 * single digits instead of building 200 operations to exercise the boundary.
 */
describe('parseRecordStream', () => {
  it('A16.41 keeps reading past the cap so an admitted operation keeps its end', async () => {
    // `s1 s2 e1 s3 e2 e3` with cap 2: `s3` is the first line past the cap, and
    // `e2` — the end of an ADMITTED operation — comes after it.
    const body = ndjson([
      startRecord({ operationId: 'op-1', caseIndex: 0 }),
      startRecord({ operationId: 'op-2', caseIndex: 1 }),
      endRecord({ operationId: 'op-1', caseIndex: 0 }),
      startRecord({ operationId: 'op-3', caseIndex: 2 }),
      endRecord({ operationId: 'op-2', caseIndex: 1 }),
      endRecord({ operationId: 'op-3', caseIndex: 2 }),
    ]);

    const parsed = await parseRecordStream(new Response(body), 2);
    const operations = groupOperations(parsed.records);

    expect(operations.map((op) => op.operationId)).toEqual(['op-1', 'op-2']);
    // Both admitted operations are whole. Dropping `e2` would render op-2 as a
    // hung call, which is a false statement about the artifact.
    expect(operations.map((op) => op.end !== undefined)).toEqual([true, true]);
    // Nothing from the operation there was no room for leaks into the page.
    expect(parsed.records.some((r) => r.operationId === 'op-3')).toBe(false);
    expect(parsed.cappedEarly).toBe(true);
    expect(parsed.malformed).toBe(0);
  });

  it('A16.42 counts records with no operation id against the cap, one row each', async () => {
    // Malformed or future-build records: `groupOperations` gives each its own
    // row (it cannot pair them safely), so each must consume a cap slot too.
    const body = ndjson([
      baseRecord({ operationId: '', caseIndex: 0 }),
      baseRecord({ operationId: '', caseIndex: 1 }),
      baseRecord({ operationId: '', caseIndex: 2 }),
    ]);

    const parsed = await parseRecordStream(new Response(body), 2);

    expect(parsed.records).toHaveLength(2);
    expect(groupOperations(parsed.records)).toHaveLength(2);
    expect(parsed.cappedEarly).toBe(true);
  });
});
