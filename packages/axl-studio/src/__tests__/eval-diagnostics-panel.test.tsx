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
 * Test-matrix rows: A16.19–A16.29 (P5b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  RunDiagnosticsPanel,
  CapturedRequestsBadge,
} from '../client/panels/eval-runner/RunDiagnosticsPanel';
import { EvalHistoryTable } from '../client/panels/eval-runner/EvalHistoryTable';
import { MAX_INLINE_RECORDS, recordsFilename } from '../client/panels/eval-runner/diagnostics';
import type { EvalHistoryEntry } from '../client/lib/types';
import type {
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

function result(diagnostics?: DiagnosticManifest): EvalResultData {
  return {
    id: RESULT_ID,
    dataset: 'qa-dataset',
    timestamp: new Date(0).toISOString(),
    totalCost: 0,
    duration: 100,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    v: 1,
    phase: 'end',
    operationId: 'op-1',
    kind: 'chat',
    caseIndex: 0,
    transportAttempts: 1,
    provider: 'openai',
    model: 'gpt-5-mini',
    request: {
      messages: [{ role: 'user', content: 'what is 2+2?' }],
      options: { model: 'gpt-5-mini', temperature: 0 },
      providerOptionKeys: ['organization'],
    },
    response: {
      content: '4',
      usage: { inputTokens: 8, outputTokens: 1 },
      timing: { totalMs: 120 },
    },
    captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
    ...overrides,
  };
}

// ── Fetch routing ────────────────────────────────────────────────

type Routes = {
  manifest?: { status: number; body: unknown };
  records?: string;
};

let calls: string[] = [];

function stubFetch(routes: Routes) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
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

let clicked: Array<{ download: string; href: string }> = [];

beforeEach(() => {
  calls = [];
  clicked = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
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

    render(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

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

    render(<RunDiagnosticsPanel result={result(truncated)} evalName="qa-eval" />);

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

    render(<RunDiagnosticsPanel result={result(gone)} evalName="qa-eval" />);

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
    const { container } = render(<RunDiagnosticsPanel result={result()} evalName="qa-eval" />);
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

    render(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

    await screen.findByText(/unavailable — the captured bytes are not stored/);
    expect(screen.getByText('Captured requests are no longer available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download records (.jsonl)' })).toBeDisabled();
  });

  it('A16.24 downloads the records route once and names the file <eval>-<id>.requests.jsonl', async () => {
    const user = userEvent.setup();
    const body = ndjson([record()]);
    const fetchMock = stubFetch({ records: body });

    render(<RunDiagnosticsPanel result={result(manifest())} evalName="qa eval" />);
    await waitFor(() => expect(calls.some((u) => u.endsWith('/diagnostics'))).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Download records (.jsonl)' }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe(`qa-eval-${RESULT_ID}.requests.jsonl`);
    expect(recordsFilename('qa eval', RESULT_ID)).toBe(`qa-eval-${RESULT_ID}.requests.jsonl`);
    const recordCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/diagnostics/records'),
    );
    expect(recordCalls).toHaveLength(1);
  });

  it('A16.25 shows a record with its correlation and termination, and expands into the request', async () => {
    const user = userEvent.setup();
    stubFetch({
      records: ndjson([
        record({
          phase: 'start',
          operationId: 'op-hung',
          caseIndex: 4,
          scorer: 'llm-judge',
          termination: 'stream_stall_timeout',
          transportAttempts: 2,
          response: undefined,
        }),
      ]),
    });

    render(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getByText(/terminated: stream_stall_timeout/)).toBeInTheDocument();
    expect(within(list).getByText(/case 4 · llm-judge/)).toBeInTheDocument();
    expect(within(list).getByText(/attempt 2/)).toBeInTheDocument();
    expect(within(list).getByText('op-hung')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { expanded: false }));
    expect(await screen.findByTestId('record-detail-0')).toBeInTheDocument();
    expect(screen.getByText(/what is 2\+2\?/)).toBeInTheDocument();
    // A record with no response says so rather than implying an empty answer.
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('A16.26 caps the inline viewer and says so', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: MAX_INLINE_RECORDS + 25 }, (_, i) =>
      record({ operationId: `op-${i}`, caseIndex: i }),
    );
    stubFetch({ records: ndjson(many) });

    render(
      <RunDiagnosticsPanel
        result={result(manifest({ records: many.length }))}
        evalName="qa-eval"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show captured records' }));

    const list = await screen.findByRole('list', { name: 'Captured request records' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(MAX_INLINE_RECORDS);
    expect(
      screen.getByText(
        `Showing the first ${MAX_INLINE_RECORDS} records. Download the .jsonl for the rest.`,
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

    render(<RunDiagnosticsPanel result={result(manifest())} evalName="qa-eval" />);

    expect(await screen.findByText('artifact artifact-src (run run-src)')).toBeInTheDocument();
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
