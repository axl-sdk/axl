/**
 * Eval-side request capture (plan A11.3, A12.7, A13.3/A13.19 support).
 *
 * The core package owns the record format, the bounds and the artifact
 * lifecycle; what this file defends is the eval-shaped half: which run, case
 * and scorer a captured operation belongs to, whether a judge's calls are
 * captured at all, and whether a rescore's copied evidence still points at the
 * operations the original run performed.
 *
 * Every case drives the public `runEval` / `rescore` entry points against a
 * real `AxlRuntime` with a real file-backed artifact store, because a capture
 * that works against an in-memory double proves nothing about the artifact a
 * user actually reads back.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AxlRuntime } from '@axlsdk/axl';
import type { AxlRuntime as AxlRuntimeType, CapturedRequestRecord } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { rescore } from '../rescore.js';
import {
  parseRequestRecords,
  serializeRequestRecords,
  validateRequestSidecar,
  resolveCaptureLimits,
} from '../diagnostics.js';
import type { EvalConfig } from '../types.js';
import { ScriptedProvider, askExecute } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'axl-eval-diag-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

/** A runtime whose artifacts land in this test's temp root. */
function captureRuntime(turns = 4): AxlRuntimeType {
  const provider = new ScriptedProvider(
    Array.from({ length: turns }, () => ({ cost: 0.01, content: 'answer' })),
    { name: 'mock' },
  );
  const runtime = new AxlRuntime({
    defaultProvider: 'mock',
    trace: { enabled: false },
    diagnostics: { artifacts: { root, sweepIntervalMs: 3_600_000 } },
  });
  runtime.registerProvider('mock', provider);
  return runtime;
}

/** An LLM judge on its own provider, so judging calls are isolable. */
function judgeOn(runtime: AxlRuntimeType, name = 'judge') {
  runtime.registerProvider('judgep', {
    name: 'judgep',
    chat: async () => ({
      content: JSON.stringify({ score: 0.5, reasoning: 'x' }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0.02,
    }),
  } as never);
  return llmScorer({
    name,
    description: 'judge',
    model: 'judgep:model',
    system: 'Rate it',
    schema: z.object({ score: z.number(), reasoning: z.string() }),
  });
}

/** Read every record out of an artifact, going through the store directly. */
async function readRecords(
  runtime: AxlRuntimeType,
  artifactId: string,
): Promise<CapturedRequestRecord[]> {
  const opened = await runtime.getDiagnosticArtifactStore()!.open(artifactId);
  const records: CapturedRequestRecord[] = [];
  for await (const line of opened!.lines) {
    records.push(JSON.parse(line) as CapturedRequestRecord);
  }
  return records;
}

// ── A11.3 / operation refs ───────────────────────────────────────────

describe('A11.3 — judge calls are captured', () => {
  it('attaches judging operations to the scorer detail, not just to the item', async () => {
    const runtime = captureRuntime(6);
    const judge = judgeOn(runtime);

    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [judge] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );

    const detail = result.items[0].scoreDetails?.judge;
    // Capture wired only into the workflow path would leave this empty — and
    // the judge call is exactly the one a user disputes.
    expect(detail?.diagnostics?.operations.length).toBeGreaterThan(0);

    const records = await readRecords(runtime, result.diagnostics!.artifactId);
    const judgeOps = new Set(detail!.diagnostics!.operations.map((op) => op.operationId));
    const judgeRecords = records.filter((r) => judgeOps.has(r.operationId));
    expect(judgeRecords.length).toBeGreaterThan(0);
    // The `scorer` stamp is what separates a judge call from the case's own
    // calls inside a single artifact, and the provider confirms it really is
    // the judge's model rather than a mislabelled generation call.
    expect(judgeRecords.every((r) => r.scorer === 'judge')).toBe(true);
    expect(judgeRecords.every((r) => r.provider === 'judgep')).toBe(true);
    // The case's own generation calls stay unlabelled, so a reader can tell
    // the two apart inside one artifact.
    const generation = records.filter((r) => r.scorer === undefined);
    expect(generation.length).toBeGreaterThan(0);
    expect(generation.every((r) => r.provider === 'mock')).toBe(true);
    await runtime.shutdown();
  });

  it('separates each case with a caseIndex the item refs agree with', async () => {
    const runtime = captureRuntime(4);

    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );

    const records = await readRecords(runtime, result.diagnostics!.artifactId);
    for (const [index, item] of result.items.entries()) {
      const ops = item.diagnostics?.operations ?? [];
      expect(ops.length).toBeGreaterThan(0);
      const ids = new Set(ops.map((op) => op.operationId));
      const mine = records.filter((r) => ids.has(r.operationId));
      // Mixing two cases' records under one item is a wrong-evidence bug, not
      // a cosmetic one.
      expect(mine.every((r) => r.caseIndex === index)).toBe(true);
    }
    await runtime.shutdown();
  });

  it('reports the manifest fidelity as the runtime request, never the wire payload', async () => {
    const runtime = captureRuntime(2);
    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );

    expect(result.diagnostics).toMatchObject({
      version: 1,
      fidelity: 'runtime_request',
      status: 'complete',
    });
    expect(result.diagnostics!.records).toBeGreaterThan(0);
    await runtime.shutdown();
  });
});

// ── A12.7 — off by default ───────────────────────────────────────────

describe('A12.7 — capture is off unless asked for', () => {
  it('produces no manifest, no refs and no artifact directory', async () => {
    const runtime = captureRuntime(2);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
    );

    expect(result.diagnostics).toBeUndefined();
    expect(result.items[0].diagnostics).toBeUndefined();
    expect(result.items[0].scoreDetails?.pass?.diagnostics).toBeUndefined();
    // Compact default artifacts silently growing is the regression this kills.
    expect(await readdir(root)).toEqual([]);
    // And the serialized result carries no message-bearing field at all.
    expect(JSON.stringify(result)).not.toContain('messages');
    await runtime.shutdown();
  });

  it('accounting is identical with capture on and off', async () => {
    const off = captureRuntime(2);
    const withoutCapture = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      off,
    );
    await off.shutdown();

    const on = captureRuntime(2);
    const withCapture = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      on,
      { captureRequests: true },
    );
    await on.shutdown();

    // The diagnostics rail must never move the accounting rail.
    expect(withCapture.accounting).toEqual(withoutCapture.accounting);
    expect(withCapture.totalCost).toBeCloseTo(withoutCapture.totalCost, 10);
  });
});

// ── Rescore provenance ───────────────────────────────────────────────

describe('rescore copies evidence without inventing it', () => {
  it('copies the source artifact, preserving the original operation ids', async () => {
    const runtime = captureRuntime(4);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );
    const sourceRecords = await readRecords(runtime, original.diagnostics!.artifactId);
    const sourceIds = sourceRecords.map((r) => r.operationId);

    const rescored = await rescore(original, [pass], runtime, { captureRequests: true });

    expect(rescored.diagnostics!.artifactId).not.toBe(original.diagnostics!.artifactId);
    const copied = await readRecords(runtime, rescored.diagnostics!.artifactId);
    // Renumbering on copy would break every ref the original items carry.
    expect(copied.map((r) => r.operationId)).toEqual(expect.arrayContaining(sourceIds));
    await runtime.shutdown();
  });

  it('preserves the original item diagnostics on the rescored items', async () => {
    const runtime = captureRuntime(4);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );

    const rescored = await rescore(original, [pass], runtime, { captureRequests: true });

    // A rescore performs no generation, so the item's generation evidence is
    // the ORIGINAL run's — claiming otherwise would attribute calls that this
    // rescore never made.
    expect(rescored.items[0].diagnostics).toEqual(original.items[0].diagnostics);
    await runtime.shutdown();
  });

  it('degrades to an unavailable manifest when the source artifact is gone', async () => {
    const runtime = captureRuntime(4);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );
    await runtime.getDiagnosticArtifactStore()!.delete(original.diagnostics!.artifactId);

    const rescored = await rescore(original, [pass], runtime, { captureRequests: true });

    // Losing the source evidence must not lose the rescore's numbers.
    expect(rescored.diagnostics!.status).toBe('unavailable');
    expect(rescored.diagnostics!.reason).toBeTruthy();
    expect(rescored.items[0].scores.pass).toBe(1);
    await runtime.shutdown();
  });
});

// ── Rescore capture (M1) and degrade ownership (H2) ──────────────────

describe('a rescore records the judging it actually performs (M1)', () => {
  it('captures its judge calls into its own artifact, correlated to the case', async () => {
    const runtime = captureRuntime(4);
    const judge = judgeOn(runtime);
    const original = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );
    const sourceIds = new Set(
      (await readRecords(runtime, original.diagnostics!.artifactId)).map((r) => r.operationId),
    );

    const rescored = await rescore(original, [judge], runtime, { captureRequests: true });

    const records = await readRecords(runtime, rescored.diagnostics!.artifactId);
    // Everything the rescore itself did: the source records are copies, so the
    // new work is whatever is NOT one of them.
    const judged = records.filter((r) => !sourceIds.has(r.operationId));
    // `captureRequests` on a rescore promises the judge calls are recorded; an
    // artifact holding only the copy is a rescore that captured nothing it did.
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((r) => r.scorer === 'judge')).toBe(true);
    // Without the per-item correlation scope a reader cannot tell which case a
    // judge call scored, which is the whole point of pointing at it.
    expect(new Set(judged.map((r) => r.caseIndex))).toEqual(new Set([0, 1]));

    // And the result points at them from the scorer that made them.
    const ops = rescored.items[0].scoreDetails?.judge?.diagnostics?.operations ?? [];
    expect(ops.length).toBeGreaterThan(0);
    expect(judged.map((r) => r.operationId)).toEqual(
      expect.arrayContaining(ops.map((o) => o.operationId)),
    );
    await runtime.shutdown();
  });

  it('carries the copied bytes against the same run bound', async () => {
    const runtime = captureRuntime(4);
    const judge = judgeOn(runtime);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );

    // A bound the copy alone already exhausts. If the channel started its own
    // budget from zero the artifact would quietly grow to twice the bound the
    // caller asked for.
    const rescored = await rescore(original, [judge], runtime, {
      captureRequests: { maxRunBytes: original.diagnostics!.bytes + 32 },
    });

    expect(rescored.diagnostics!.status).toBe('truncated');
    expect(rescored.diagnostics!.bytes).toBeLessThanOrEqual(original.diagnostics!.bytes + 32);
    expect(rescored.items[0].scores.judge).toBe(0.5);
    await runtime.shutdown();
  });
});

describe('a degraded rescore never names the source artifact (H2)', () => {
  it('publishes no artifact when the copy fails, and deleting it spares the source', async () => {
    const runtime = captureRuntime(4);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] } satisfies EvalConfig,
      askExecute(),
      runtime,
      { captureRequests: true },
    );
    const sourceId = original.diagnostics!.artifactId;
    await runtime.saveEvalResult({
      id: original.id,
      eval: 'w',
      timestamp: Date.now(),
      data: original,
    });

    // A transient storage failure during the copy — the disk was full, the
    // object store timed out. The rescore's numbers must survive it.
    const store = runtime.getDiagnosticArtifactStore()!;
    const realCopy = store.copy.bind(store);
    store.copy = async () => {
      throw new Error('object store unreachable');
    };
    const rescored = await rescore(original, [pass], runtime, { captureRequests: true });
    store.copy = realCopy;

    expect(rescored.items[0].scores.pass).toBe(1);
    expect(rescored.diagnostics!.status).toBe('unavailable');
    // Naming the source here is the bug: the rescore would then own a lifecycle
    // over another run's evidence.
    expect(rescored.diagnostics!.artifactId).toBe('');

    await runtime.saveEvalResult({
      id: rescored.id,
      eval: 'w',
      timestamp: Date.now(),
      data: rescored,
    });
    expect(await runtime.deleteEvalResult(rescored.id)).toBe(true);

    // The source run still has everything it captured.
    expect(await store.open(sourceId)).toBeDefined();
    expect(await runtime.openDiagnosticArtifact(sourceId)).toBeDefined();
    await runtime.shutdown();
  });
});

// ── Codec + sidecar validation ───────────────────────────────────────

describe('the JSONL codec and its import guard', () => {
  const record = (over: Partial<CapturedRequestRecord> = {}): CapturedRequestRecord =>
    ({
      v: 1,
      operationId: 'op_1',
      phase: 'end',
      kind: 'chat',
      model: 'mock:m',
      startedAt: 1,
      ...over,
    }) as CapturedRequestRecord;

  it('round-trips records through serialize → validate → parse', () => {
    const records = [record(), record({ operationId: 'op_2', phase: 'start' })];
    const text = serializeRequestRecords(records);
    expect(text.endsWith('\n')).toBe(true);

    const validated = validateRequestSidecar(text);
    expect(validated.ok).toBe(true);
    expect(parseRequestRecords((validated as { lines: string[] }).lines)).toEqual(records);
  });

  it('serializes an empty set without a stray blank line', () => {
    expect(serializeRequestRecords([])).toBe('');
  });

  it('accepts a well-formed sidecar', () => {
    const result = validateRequestSidecar(serializeRequestRecords([record()]));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not a string', 42],
    ['unparseable JSON', '{ nope'],
    ['a JSON array line', '[1,2,3]'],
    ['an unsupported codec version', JSON.stringify({ v: 2, operationId: 'a', phase: 'end' })],
    ['a missing operationId', JSON.stringify({ v: 1, phase: 'end' })],
    ['an empty operationId', JSON.stringify({ v: 1, operationId: '', phase: 'end' })],
    ['an unknown phase', JSON.stringify({ v: 1, operationId: 'a', phase: 'middle' })],
  ])('refuses %s', (_label, body) => {
    const result = validateRequestSidecar(body);
    expect(result.ok).toBe(false);
    // A stored-and-puzzled-over bad record is worse than a refused import.
    expect((result as { reason: string }).reason).toBeTruthy();
  });

  it('refuses a sidecar over the byte ceiling before parsing it', () => {
    const huge = serializeRequestRecords([record({ operationId: 'x'.repeat(4096) })]);
    const result = validateRequestSidecar(huge, { maxBytes: 64 });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('64');
  });

  it('normalizes the capture option into explicit limits', () => {
    expect(resolveCaptureLimits(undefined)).toBeUndefined();
    expect(resolveCaptureLimits(false)).toBeUndefined();
    expect(resolveCaptureLimits(true)).toEqual({});
    expect(resolveCaptureLimits({ maxRunBytes: 10 })).toEqual({ maxRunBytes: 10 });
  });
});

// ── Configuration failure is early and loud ──────────────────────────

describe('capture on a runtime that cannot host it', () => {
  it('fails before the dataset is touched rather than mid-run', async () => {
    const provider = new ScriptedProvider([{ cost: 0.01 }], { name: 'mock' });
    const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: { enabled: false } });
    runtime.registerProvider('mock', provider);
    let itemsRead = false;
    const spyDataset = {
      ...ds(1),
      getItems: async () => {
        itemsRead = true;
        return (await ds(1).getItems()) as never;
      },
    };

    await expect(
      runEval(
        { workflow: 'w', dataset: spyDataset as never, scorers: [pass] } satisfies EvalConfig,
        askExecute(),
        runtime,
        { captureRequests: true },
      ),
    ).rejects.toMatchObject({ code: 'DIAGNOSTICS_UNAVAILABLE' });

    // Failing after the run has already spent money is the bug.
    expect(itemsRead).toBe(false);
    expect(provider.callCount).toBe(0);
  });
});
