/**
 * Studio's captured-request surface (plan A13.19, A13.20, plus the import
 * accounting-validation addendum and the redact-mode metadata policy).
 *
 * The import endpoint is the only place a stranger's JSON reaches this
 * subsystem, so most of what is asserted here is about what the server REFUSES
 * to believe: a declared accounting record that does not add up, a sidecar that
 * is really a filesystem path, an artifact id chosen by the exporter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'axl-studio-diag-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A minimal but complete result whose declared accounting is internally consistent. */
function resultWithAccounting(over: Record<string, unknown> = {}) {
  return {
    id: 'exported-id',
    workflow: 'imported-wf',
    dataset: 'imported-ds',
    metadata: {},
    timestamp: new Date().toISOString(),
    totalCost: 0.5,
    duration: 10,
    items: [{ input: 'in', output: 'out', scores: { 'always-pass': 1 } }],
    summary: {
      count: 1,
      failures: 0,
      scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
    },
    accounting: {
      version: 1,
      currency: 'USD',
      knownCost: 0.5,
      completeness: 'complete',
      operations: { total: 2, settled: 2, unknown: 0, denied: 0, byKind: { chat: 2 } },
      provenance: { price_table_estimate: 0.5 },
      breakdown: { generation: 0.4, judging: 0.1, external: 0 },
      reasons: {},
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        audioSeconds: 0,
      },
    },
    ...over,
  };
}

function sidecar(records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const RECORDS = [
  {
    v: 1,
    phase: 'start',
    operationId: 'op_1',
    kind: 'chat',
    transportAttempts: 1,
    provider: 'mock',
    model: 'mock:test',
    request: { messages: [{ role: 'user', content: 'the original question' }] },
    captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
  },
  {
    v: 1,
    phase: 'end',
    operationId: 'op_1',
    kind: 'chat',
    transportAttempts: 1,
    provider: 'mock',
    model: 'mock:test',
    response: { content: 'the original answer' },
    captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
  },
];

async function importResult(
  app: { request: (p: string, init?: RequestInit) => Promise<Response> },
  body: Record<string, unknown>,
) {
  return app.request('/api/evals/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── A13.19 — import/export roundtrip ─────────────────────────────────

describe('A13.19 — import/export roundtrip', () => {
  it('preserves accounting and re-owns the captured requests under the new id', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    const newId: string = data.id;

    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === newId);
    // The measured numbers are the payload; losing them on import makes the
    // bundle worthless.
    expect(entry.data.accounting).toEqual(resultWithAccounting().accounting);
    expect(entry.data.metadata.importedAccounting).toBe('declared');
    // The exporter's artifact id names storage in a deployment this one knows
    // nothing about, so it must not survive.
    expect(entry.data.diagnostics.artifactId).not.toBe('exported-id');
    expect(entry.data.diagnostics.artifactId).toBeTruthy();
    expect(entry.data.diagnostics.status).toBe('complete');

    const manifest = await readJson(await app.request(`/api/evals/${newId}/diagnostics`));
    expect(manifest.data.records).toBe(2);
    expect(manifest.data.fidelity).toBe('runtime_request');

    const recordsRes = await app.request(`/api/evals/${newId}/diagnostics/records`);
    expect(recordsRes.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await recordsRes.text();
    const roundTripped = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // Export must reproduce what was imported, or the bundle is not a bundle.
    expect(roundTripped).toEqual(RECORDS);

    // And the exported sidecar re-imports cleanly — the roundtrip closes.
    const again = await importResult(app, { result: resultWithAccounting(), requests: text });
    expect(again.status).toBe(200);
  });

  it('resolves records only through the history id, never an id the caller supplies', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });
    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const artifactId = histBody.data.find((e: { id: string }) => e.id === data.id).data.diagnostics
      .artifactId;

    // Addressing the artifact directly must not work: the route takes an eval
    // history id, and the ownership check is the whole access control.
    const direct = await app.request(`/api/evals/${artifactId}/diagnostics`);
    expect(direct.status).toBe(404);
  });

  it.each([
    ['an absolute filesystem path', '/etc/passwd'],
    ['a relative path', '../../secrets/requests.jsonl'],
    ['an external URL', 'https://attacker.example/requests.jsonl'],
    ['a file URL', 'file:///var/log/axl/requests.jsonl'],
  ])('refuses a sidecar that is really %s', async (_label, requests) => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, { result: resultWithAccounting(), requests });

    // Arbitrary path/URL fetch from imported JSON is the bug being killed: the
    // server never dereferences anything, and a non-JSONL body is refused.
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('refuses a sidecar accompanying a multi-result bundle', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      results: [resultWithAccounting(), resultWithAccounting()],
      requests: sidecar(RECORDS),
    });

    // Which of the two runs would own the records? There is no honest answer,
    // so silently attaching them to both is the failure mode this prevents.
    expect(res.status).toBe(400);
  });

  it('rejects a malformed sidecar before storing any result', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: '{"v":1,"operationId":"op_1","phase":"end"}\nnot json\n',
    });

    expect(res.status).toBe(400);
    // A half-imported run is worse than a refused one.
    const histBody = await readJson(await app.request('/api/evals/history'));
    expect(histBody.data).toEqual([]);
  });
});

// ── A13.20 — the attachment is missing ───────────────────────────────

describe('A13.20 — import with a missing attachment', () => {
  it('imports the numbers and marks the evidence unavailable', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      result: resultWithAccounting({
        diagnostics: {
          version: 1,
          artifactId: 'artifact-from-elsewhere',
          fidelity: 'runtime_request',
          status: 'complete',
          records: 2,
          bytes: 100,
          redaction: 'none',
        },
      }),
    });

    // Hard-failing on a missing sidecar throws away a perfectly good result.
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);

    expect(entry.data.items.length).toBe(1);
    expect(entry.data.accounting.knownCost).toBe(0.5);
    expect(entry.data.diagnostics.status).toBe('unavailable');
    // The dangling id would send a reader chasing storage that does not exist.
    expect(entry.data.diagnostics.artifactId).toBe('');

    const manifest = await app.request(`/api/evals/${data.id}/diagnostics`);
    expect(manifest.status).toBe(404);
  });

  it('imports without capture configured at all', async () => {
    // No artifactsRoot: this deployment has nowhere to put evidence.
    const { app } = createTestServer();

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });

    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    // The numbers still land; only the evidence is reported as unavailable.
    expect(entry.data.accounting.knownCost).toBe(0.5);
    expect(entry.data.diagnostics.status).toBe('unavailable');
    expect(entry.data.diagnostics.reason).toMatch(/could not be stored/i);
  });
});

// ── Import accounting validation (lead addendum) ─────────────────────

describe('imported accounting is validated before it is trusted', () => {
  it('keeps a structurally valid record and marks it declared', async () => {
    const { app } = createTestServer();

    const res = await importResult(app, { result: resultWithAccounting() });

    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    expect(entry.data.accounting.completeness).toBe('complete');
    expect(entry.data.metadata.importedAccounting).toBe('declared');
  });

  it.each([
    ['provenance that does not sum to knownCost', { provenance: { price_table_estimate: 0.1 } }],
    [
      'a breakdown that does not sum to knownCost',
      { breakdown: { generation: 9, judging: 0, external: 0, memory: 0 } },
    ],
    [
      'an operations identity that does not hold',
      { operations: { total: 5, settled: 2, unknown: 0, denied: 0, byKind: { chat: 2 } } },
    ],
    ['a negative knownCost', { knownCost: -1 }],
    ['a non-USD currency', { currency: 'EUR' }],
    ['an unknown completeness', { completeness: 'perfect' }],
    ['an unsupported version', { version: 2 }],
  ])('replaces %s with an unverified synthesis', async (_label, patch) => {
    const { app } = createTestServer();
    const forged = resultWithAccounting();
    Object.assign(forged.accounting, patch);

    const res = await importResult(app, { result: forged });

    // Import never rejects solely because of accounting — it downgrades.
    expect(res.status).toBe(200);
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    // A hand-edited artifact declaring `complete` must never get certified by
    // compare on the strength of its own say-so.
    expect(entry.data.accounting.completeness).toBe('unverified');
    expect(entry.data.metadata.importedAccounting).toBe('invalid');
  });

  it('accepts an unverified record as-is without checking the sum identities', async () => {
    const { app } = createTestServer();
    const legacyish = resultWithAccounting();
    // An `unverified` record is a synthesis, not a measurement: its provenance
    // and breakdown are deliberately incomplete, so holding it to the sum
    // identities would downgrade an honest record for being honest.
    Object.assign(legacyish.accounting, {
      completeness: 'unverified',
      provenance: {},
      breakdown: { generation: 0, judging: 0, external: 0, memory: 0 },
    });

    const res = await importResult(app, { result: legacyish });

    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    expect(entry.data.accounting.completeness).toBe('unverified');
    expect(entry.data.metadata.importedAccounting).toBe('declared');
  });

  it('synthesizes unverified accounting when none is supplied', async () => {
    const { app } = createTestServer();
    const noAccounting = resultWithAccounting();
    delete (noAccounting as { accounting?: unknown }).accounting;

    const res = await importResult(app, { result: noAccounting });

    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    expect(entry.data.accounting.completeness).toBe('unverified');
    // Nothing was declared, so nothing was judged — the marker stays absent.
    expect(entry.data.metadata.importedAccounting).toBeUndefined();
  });
});

// ── Redaction (M4 + A16.16 structural fields) ────────────────────────

describe('budget and coverage are validated with the accounting (I2)', () => {
  /** A result claiming a budget stop, with the numbers to back it — or not. */
  function budgetStopped(over: {
    budget?: Record<string, unknown>;
    coverage?: Record<string, unknown>;
  }) {
    const base = resultWithAccounting();
    return {
      ...base,
      accounting: {
        ...base.accounting,
        budget: over.budget ?? {
          limit: 1,
          status: 'closed',
          knownSpend: 1.25,
          knownOvershoot: 0.25,
          closedBy: 'case',
        },
      },
      summary: {
        ...base.summary,
        coverage: over.coverage ?? {
          items: {
            completed: 1,
            failed: 0,
            cancelled: 0,
            budget_skipped: 3,
            budget_interrupted: 0,
          },
          scorers: {
            'always-pass': {
              scored: 1,
              failed: 0,
              skipped: 0,
              cancelled: 0,
              budget_skipped: 3,
              budget_interrupted: 0,
            },
          },
        },
      },
    };
  }

  async function importAndRead(result: Record<string, unknown>) {
    const { app } = createTestServer(undefined, { artifactsRoot: root });
    const res = await importResult(app, { result });
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    return histBody.data.find((e: { id: string }) => e.id === data.id);
  }

  it('keeps a budget block whose overshoot identity holds', async () => {
    const entry = await importAndRead(budgetStopped({}));

    expect(entry.data.metadata.importedAccounting).toBe('declared');
    expect(entry.data.accounting.budget.status).toBe('closed');
    expect(entry.data.summary.coverage.items.budget_skipped).toBe(3);
  });

  it('refuses a forged budget block and strips the badge with it', async () => {
    // `closed` with an overshoot that does not follow from the spend and the
    // limit: the shape a hand-edited artifact takes when someone wants a run's
    // missing cases excused as a budget stop rather than read as failures.
    const entry = await importAndRead(
      budgetStopped({
        budget: { limit: 1, status: 'closed', knownSpend: 1.25, knownOvershoot: 0 },
      }),
    );

    expect(entry.data.metadata.importedAccounting).toBe('invalid');
    // Both halves of the verdict must go: keeping either would let a reader
    // badge this run budget-stopped on a claim that just failed validation.
    expect(entry.data.accounting?.budget).toBeUndefined();
    expect(entry.data.summary?.coverage).toBeUndefined();
  });

  it('refuses a closed budget that no controller could have closed (N3)', async () => {
    // `AdmissionController.status` IS `knownSpend >= limit`. A $0 spend against
    // a $10 limit cannot be `closed` — and this is the cheapest possible
    // forgery of the badge, because every other identity holds trivially at
    // zero.
    const entry = await importAndRead(
      budgetStopped({
        budget: { limit: 10, status: 'closed', knownSpend: 0, knownOvershoot: 0 },
      }),
    );

    expect(entry.data.metadata.importedAccounting).toBe('invalid');
    expect(entry.data.accounting?.budget).toBeUndefined();
    expect(entry.data.summary?.coverage).toBeUndefined();
  });

  it('keeps an open budget below its limit', async () => {
    const entry = await importAndRead(
      budgetStopped({
        budget: { limit: 10, status: 'open', knownSpend: 4, knownOvershoot: 0 },
      }),
    );

    // The identity cuts both ways; a normal run must not be refused by it.
    expect(entry.data.metadata.importedAccounting).toBe('declared');
    expect(entry.data.accounting.budget.status).toBe('open');
  });

  it('marks a refused coverage block invalid even with no accounting (N10)', async () => {
    const base = resultWithAccounting();
    const noAccounting = {
      ...base,
      accounting: undefined,
      summary: { ...base.summary, coverage: { items: { completed: 1 }, scorers: {} } },
    };
    delete (noAccounting as { accounting?: unknown }).accounting;

    const entry = await importAndRead(noAccounting as Record<string, unknown>);

    // Dropping it silently leaves a reader unable to tell "never had coverage"
    // from "its coverage was refused".
    expect(entry.data.summary?.coverage).toBeUndefined();
    expect(entry.data.metadata.importedAccounting).toBe('invalid');
  });

  it('refuses a coverage block that is missing outcome keys', async () => {
    // `EvalCoverage` promises every key, including zeros. A partial block reads
    // as zeros downstream, turning refused work into a clean run.
    const entry = await importAndRead(
      budgetStopped({
        coverage: {
          items: { completed: 1, budget_skipped: 3 },
          scorers: {},
        },
      }),
    );

    expect(entry.data.metadata.importedAccounting).toBe('invalid');
    expect(entry.data.summary?.coverage).toBeUndefined();
    expect(entry.data.accounting?.budget).toBeUndefined();
  });

  it('refuses coverage counts that are not counts', async () => {
    const entry = await importAndRead(
      budgetStopped({
        coverage: {
          items: {
            completed: 1,
            failed: 0,
            cancelled: 0,
            budget_skipped: 2.5,
            budget_interrupted: 0,
          },
          scorers: {},
        },
      }),
    );

    expect(entry.data.metadata.importedAccounting).toBe('invalid');
  });

  it('refuses a scorer bucket that is missing outcome keys', async () => {
    const entry = await importAndRead(
      budgetStopped({
        coverage: {
          items: {
            completed: 1,
            failed: 0,
            cancelled: 0,
            budget_skipped: 3,
            budget_interrupted: 0,
          },
          scorers: { 'always-pass': { scored: 1 } },
        },
      }),
    );

    expect(entry.data.metadata.importedAccounting).toBe('invalid');
    expect(entry.data.summary?.coverage).toBeUndefined();
  });
});

describe('what a delivered artifact says about itself (L1, L7)', () => {
  it("reports the imported records' own redaction, not this deployment's setting", async () => {
    // A bundle exported from a compliance-mode deployment, imported here where
    // redaction is off. The bytes are scrubbed; nothing about this server
    // changes that.
    const redactedRecords = RECORDS.map((r) => ({
      ...r,
      captured: { ...r.captured, redacted: true },
    }));
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(redactedRecords),
    });
    const { data } = await readJson(res);

    const manifest = await readJson(await app.request(`/api/evals/${data.id}/diagnostics`));
    // Telling a compliance reader these records are unredacted, when every one
    // of them says otherwise, is the failure: they act on this field.
    expect(manifest.data.redaction).toBe('applied');
  });

  it('reports raw imported records as unredacted', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root, redact: true });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    const { data } = await readJson(res);

    const manifest = await readJson(await app.request(`/api/evals/${data.id}/diagnostics`));
    // The opposite error, and the worse one: this deployment redacts on
    // delivery, but the stored bytes are raw and the manifest must say so.
    expect(manifest.data.redaction).toBe('none');
  });

  it('emits a valid record for a stored line that cannot be parsed', async () => {
    const { app, runtime } = createTestServer(undefined, { artifactsRoot: root, redact: true });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const artifactId = histBody.data.find((e: { id: string }) => e.id === data.id).data.diagnostics
      .artifactId;

    // Half a line on disk: a crash mid-append, a truncated restore.
    const store = runtime.getDiagnosticArtifactStore()!;
    await store.append(artifactId, '{"v":1,"operationId":"op_2"');

    const text = await (await app.request(`/api/evals/${data.id}/diagnostics/records`)).text();
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const stub = lines[lines.length - 1];
    // This stream is re-importable. A placeholder missing `operationId` or a
    // known `phase` makes `validateRequestSidecar` reject the WHOLE bundle over
    // one unreadable line.
    expect(stub.operationId).toBeTruthy();
    expect(stub.phase).toBe('end');
    expect(stub.v).toBe(1);
    const again = await importResult(app, { result: resultWithAccounting(), requests: text });
    expect(again.status).toBe(200);
  });

  it('stops reading the artifact when the consumer walks away (L6)', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    const { data } = await readJson(res);

    const stream = (await app.request(`/api/evals/${data.id}/diagnostics/records`)).body!;
    const reader = stream.getReader();
    await reader.read();
    // A closed tab, an aborted fetch. Without a `cancel()` the route keeps
    // pulling lines for nobody and enqueues into a controller that is gone,
    // which throws where nothing is waiting to catch it.
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe('redact mode', () => {
  it('masks unmeasured item metadata while keeping the measured keys', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root, redact: true });
    const withMetadata = resultWithAccounting();
    withMetadata.items = [
      {
        input: 'in',
        output: 'out',
        scores: { 'always-pass': 1 },
        metadata: {
          models: ['mock:test'],
          tokens: 15,
          agentCalls: 1,
          customerEmail: 'someone@example.com',
        },
      },
    ] as never;

    const res = await importResult(app, { result: withMetadata });
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);
    const itemMetadata = entry.data.items[0].metadata;

    // Measured keys are structural and are what the panels chart.
    expect(itemMetadata.models).toEqual(['mock:test']);
    expect(itemMetadata.tokens).toBe(15);
    // Anything else is caller-controlled content and leaks in redact mode.
    expect(itemMetadata.customerEmail).not.toBe('someone@example.com');
    expect(JSON.stringify(entry)).not.toContain('someone@example.com');
  });

  it('keeps the structural accounting fields intact under redaction', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root, redact: true });

    const res = await importResult(app, { result: resultWithAccounting() });
    const { data } = await readJson(res);
    const histBody = await readJson(await app.request('/api/evals/history'));
    const entry = histBody.data.find((e: { id: string }) => e.id === data.id);

    // Redaction removes content, never numbers: a panel reading these fields
    // must not silently show nothing in redact mode.
    expect(entry.data.accounting.knownCost).toBe(0.5);
    expect(entry.data.accounting.completeness).toBe('complete');
    expect(entry.data.accounting.operations.total).toBe(2);
  });

  it('redacts captured request content on the way out', async () => {
    const { app } = createTestServer(undefined, { artifactsRoot: root, redact: true });

    const res = await importResult(app, {
      result: resultWithAccounting(),
      requests: sidecar(RECORDS),
    });
    const { data } = await readJson(res);

    const text = await (await app.request(`/api/evals/${data.id}/diagnostics/records`)).text();

    // Redaction is applied again at delivery, not only before the write — the
    // artifact may predate the flag being switched on.
    expect(text).not.toContain('the original question');
    expect(text).not.toContain('the original answer');
    // The structure survives, so the record is still readable as a record.
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.operationId)).toEqual(['op_1', 'op_1']);
    expect(lines.every((l) => l.captured.redacted === true)).toBe(true);
  });
});
