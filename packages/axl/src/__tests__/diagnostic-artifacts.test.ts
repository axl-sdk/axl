/**
 * Diagnostic artifact lifecycle (plan A12.9, A13.8–A13.18).
 *
 * The artifact and the eval history row live in different stores, so every
 * interesting failure is a partial one: the history row saved but the artifact
 * did not, the artifact committed but the row never landed, the row expired
 * server-side while this process was offline, a writer died mid-run. Each of
 * those has exactly one correct outcome and this file pins them down.
 *
 * The rule underneath all of them: it is always better to lose diagnostic bytes
 * than to serve bytes whose owner is gone, and always better to surface a
 * failure than to report a partial delete as success.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AxlRuntime } from '../runtime.js';
import { AxlError } from '../errors.js';
import { FileDiagnosticArtifactStore } from '../diagnostics/artifact-store.js';
import { RequestCaptureChannel } from '../diagnostics/capture.js';
import type {
  ArtifactManifest,
  ArtifactOwner,
  DiagnosticArtifactStore,
} from '../diagnostics/artifact-store.js';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import type { StateStore, EvalHistoryEntry } from '../state/types.js';

const OWNER: ArtifactOwner = { kind: 'eval', id: 'run-1' };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'axl-artifacts-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A runtime with artifacts configured on `root` and a store of your choosing. */
function artifactRuntime(options?: {
  store?: StateStore;
  sweepIntervalMs?: number;
  leaseMs?: number;
  artifactStore?: DiagnosticArtifactStore;
}): AxlRuntime {
  return new AxlRuntime({
    state: { store: options?.store ?? new MemoryStore() },
    diagnostics: {
      artifacts: {
        ...(options?.artifactStore ? { store: options.artifactStore } : { root }),
        // Long enough that nothing sweeps during a test unless the test says so.
        sweepIntervalMs: options?.sweepIntervalMs ?? 3_600_000,
        leaseMs: options?.leaseMs ?? 3_600_000,
      },
    },
  });
}

/** Stage, write one record, finalize — the shape every save test starts from. */
async function stagedResult(
  runtime: AxlRuntime,
  id: string,
): Promise<{ artifactId: string; data: Record<string, unknown> }> {
  const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id });
  await staged.sink.append(JSON.stringify({ v: 1, phase: 'start', operationId: 'op_1' }));
  await runtime.finalizeDiagnosticArtifact(staged.artifactId, 'complete');
  return {
    artifactId: staged.artifactId,
    data: { id, totalCost: 0, items: [], diagnostics: { artifactId: staged.artifactId } },
  };
}

async function drain(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

// ── The store itself ─────────────────────────────────────────────────

describe('FileDiagnosticArtifactStore', () => {
  it('writes manifests atomically (a temp file never survives a completed write)', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    const staged = await store.stage(OWNER, { leaseMs: 1000 });
    await store.append(staged.artifactId, '{"a":1}');
    await store.finalize(staged.artifactId, 'complete');

    const files = await readdir(path.join(root, staged.artifactId));
    expect(files.sort()).toEqual(['manifest.json', 'records.jsonl']);
    // A half-written manifest would make the artifact unreadable AND
    // unreclaimable — the sweep parses it to decide.
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('A12.9 reports an unfinalized writer as interrupted with readable records', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    const staged = await store.stage(OWNER, { leaseMs: 1000 });
    await store.append(staged.artifactId, '{"n":1}');
    await store.append(staged.artifactId, '{"n":2}');
    // No finalize: exactly what process death looks like from the outside.

    const opened = await store.open(staged.artifactId);
    expect(opened!.manifest.status).toBe('interrupted');
    // An unreadable artifact bricking the result is the bug — the records up to
    // the truncation point are still evidence.
    expect(await drain(opened!.lines)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('refuses an artifact id that tries to escape the root', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    await expect(store.open('../../etc')).rejects.toBeInstanceOf(AxlError);
  });

  it('copy is bounded and records its provenance', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    const source = await store.stage(OWNER, { leaseMs: 1000 });
    for (let i = 0; i < 5; i++) {
      await store.append(
        source.artifactId,
        JSON.stringify({ operationId: `op_${i}`, pad: 'x'.repeat(50) }),
      );
    }
    await store.finalize(source.artifactId, 'complete');

    const copied = await store.copy(
      source.artifactId,
      { kind: 'eval', id: 'run-2' },
      {
        maxBytes: 150,
        leaseMs: 1000,
      },
    );

    expect(copied!.truncated).toBe(true);
    const opened = await store.open(copied!.artifactId);
    const lines = await drain(opened!.lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(5);
    // Original operation ids survive: that link is the whole point of a copy.
    expect(JSON.parse(lines[0]).operationId).toBe('op_0');
    expect(opened!.manifest.copiedFrom).toEqual({
      artifactId: source.artifactId,
      ownerId: 'run-1',
    });
  });

  it('delete and markDeletePending are idempotent', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    const staged = await store.stage(OWNER, { leaseMs: 1000 });
    await store.markDeletePending(staged.artifactId);
    await store.markDeletePending(staged.artifactId);
    await store.delete(staged.artifactId);
    await expect(store.delete(staged.artifactId)).resolves.toBeUndefined();
    await expect(store.open(staged.artifactId)).resolves.toBeUndefined();
  });
});

// ── Configuration rejection ──────────────────────────────────────────

describe('A13.18 — capture configuration is rejected early', () => {
  it('rejects a custom store without getEvalRetention AT CONSTRUCTION', () => {
    const custom: StateStore = {
      async saveExecution() {},
      async getPendingDecisions() {
        return [];
      },
      async savePendingDecision() {},
      async deletePendingDecision() {},
      async saveSession() {},
      async getSession() {
        return undefined;
      },
      async saveMemory() {},
      async getMemory() {
        return undefined;
      },
      async listMemory() {
        return [];
      },
      async deleteMemory() {},
      async saveEvalResult() {},
      async listEvalResults() {
        return [];
      },
    } as unknown as StateStore;

    // Late failure after a run has already spent money is the bug this kills.
    expect(
      () =>
        new AxlRuntime({
          state: { store: custom },
          diagnostics: { artifacts: { root } },
        }),
    ).toThrow(/getEvalRetention/);
  });

  it('rejects an artifacts block with neither root nor store', () => {
    expect(() => new AxlRuntime({ diagnostics: { artifacts: {} } })).toThrow(/root|store/);
  });

  it('refuses to stage when capture was never configured', async () => {
    const runtime = new AxlRuntime();
    await expect(runtime.stageDiagnosticArtifact(OWNER)).rejects.toMatchObject({
      code: 'DIAGNOSTICS_UNAVAILABLE',
    });
  });
});

// ── Save / delete lifecycle ──────────────────────────────────────────

describe('A13 — save, delete and reconciliation', () => {
  it('A13.8 round-trips diagnostics through the Memory store and commits the artifact', async () => {
    const runtime = artifactRuntime();
    const { artifactId, data } = await stagedResult(runtime, 'run-mem');
    await runtime.saveEvalResult({ id: 'run-mem', eval: 'e', timestamp: 1, data });

    const history = await runtime.getEvalHistory();
    expect(
      (history[0].data as { diagnostics: { artifactId: string } }).diagnostics.artifactId,
    ).toBe(artifactId);
    const store = runtime.getDiagnosticArtifactStore()!;
    const manifest = (await store.list()).find((m) => m.artifactId === artifactId)!;
    expect(manifest.state).toBe('committed');
    // Memory history never expires, so no expiry is mirrored onto the artifact.
    expect(manifest.expiresAt).toBeUndefined();
    await runtime.shutdown();
  });

  it('A13.9 round-trips through SQLite, including a reopened database file', async () => {
    const dbPath = path.join(root, 'evals.db');
    const first = artifactRuntime({ store: new SQLiteStore(dbPath) });
    const { artifactId, data } = await stagedResult(first, 'run-sqlite');
    await first.saveEvalResult({ id: 'run-sqlite', eval: 'e', timestamp: 1, data });
    await first.shutdown();

    // A fresh runtime over the same file: a column-projection read path that
    // dropped `diagnostics` would show up exactly here.
    const second = artifactRuntime({ store: new SQLiteStore(dbPath) });
    const history = await second.getEvalHistory();
    const stored = history.find((h) => h.id === 'run-sqlite')!;
    expect((stored.data as { diagnostics: { artifactId: string } }).diagnostics.artifactId).toBe(
      artifactId,
    );
    const opened = await second.openDiagnosticArtifact(artifactId);
    expect(opened).toBeDefined();
    await second.shutdown();
  });

  it('A13.12 rolls the artifact back when the history save throws', async () => {
    const failing = new MemoryStore() as MemoryStore & {
      saveEvalResult(entry: EvalHistoryEntry): Promise<void>;
    };
    failing.saveEvalResult = async () => {
      throw new Error('history store is down');
    };
    const runtime = artifactRuntime({ store: failing });
    const { data } = await stagedResult(runtime, 'run-fail');

    // The SAVE failure is what the caller needs to see, not a cleanup error.
    await expect(
      runtime.saveEvalResult({ id: 'run-fail', eval: 'e', timestamp: 1, data }),
    ).rejects.toThrow('history store is down');

    const store = runtime.getDiagnosticArtifactStore()!;
    // Committing ownership before the row exists would leave an orphan whose
    // manifest points at a history entry that never existed.
    expect(await store.list()).toEqual([]);
    await runtime.shutdown();
  });

  it('A13.13 reconciliation removes an uncommitted orphan and leaves committed data alone', async () => {
    const runtime = artifactRuntime({ leaseMs: 1 });
    const live = await stagedResult(runtime, 'run-live');
    await runtime.saveEvalResult({ id: 'run-live', eval: 'e', timestamp: 1, data: live.data });
    // A crash between staging and commit. Staged through the STORE, not the
    // runtime: a writer that died took its lease-renewal timer with it, and
    // staging through the runtime would model a writer that is still alive.
    const orphan = await runtime
      .getDiagnosticArtifactStore()!
      .stage({ kind: 'eval', id: 'run-orphan' }, { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { removed } = await runtime.reconcileDiagnosticArtifacts();

    expect(removed).toContain(orphan.artifactId);
    // A sweeper that deletes live committed data is the catastrophic bug.
    expect(removed).not.toContain(live.artifactId);
    const ids = (await runtime.getDiagnosticArtifactStore()!.list()).map((m) => m.artifactId);
    expect(ids).toEqual([live.artifactId]);
    await runtime.shutdown();
  });

  it('A13.16 never sweeps a staged artifact whose lease is still live', async () => {
    const runtime = artifactRuntime({ leaseMs: 3_600_000 });
    const active = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: 'run-active' });
    await active.sink.append('{"v":1}');

    const { removed } = await runtime.reconcileDiagnosticArtifacts();

    // Racing a live writer destroys evidence a run is still producing.
    expect(removed).toEqual([]);
    expect(await runtime.getDiagnosticArtifactStore()!.open(active.artifactId)).toBeDefined();
    await runtime.shutdown();
  });

  it('A13.14 deletes the bytes before reporting success, and is idempotent', async () => {
    const runtime = artifactRuntime();
    const { artifactId, data } = await stagedResult(runtime, 'run-del');
    await runtime.saveEvalResult({ id: 'run-del', eval: 'e', timestamp: 1, data });

    expect(await runtime.deleteEvalResult('run-del')).toBe(true);

    const store = runtime.getDiagnosticArtifactStore()!;
    // Deleting the row and leaking the attachment forever is the bug.
    expect(await store.open(artifactId)).toBeUndefined();
    expect((await store.list()).map((m) => m.artifactId)).not.toContain(artifactId);
    // The caller never re-supplies the blob, and a second delete is harmless.
    await expect(runtime.deleteEvalResult('run-del')).resolves.toBe(false);
    await runtime.shutdown();
  });

  it('A13.15 surfaces a failed artifact delete and keeps the intent for reconciliation', async () => {
    const backing = new FileDiagnosticArtifactStore({ root });
    let failDelete = true;
    const flaky: DiagnosticArtifactStore = {
      ...backing,
      stage: (owner, opts) => backing.stage(owner, opts),
      append: (id, line) => backing.append(id, line),
      finalize: (id, status, reason) => backing.finalize(id, status, reason),
      commit: (id, opts) => backing.commit(id, opts),
      rollback: (id) => backing.rollback(id),
      open: (id) => backing.open(id),
      copy: (src, owner, opts) => backing.copy(src, owner, opts),
      markDeletePending: (id) => backing.markDeletePending(id),
      list: () => backing.list(),
      refreshExpiry: (id, at) => backing.refreshExpiry(id, at),
      delete: async (id) => {
        if (failDelete) throw new Error('artifact store unreachable');
        await backing.delete(id);
      },
    };
    const runtime = artifactRuntime({ artifactStore: flaky });
    const { artifactId, data } = await stagedResult(runtime, 'run-flaky');
    await runtime.saveEvalResult({ id: 'run-flaky', eval: 'e', timestamp: 1, data });

    // Silent partial deletion reported as success is the bug.
    await expect(runtime.deleteEvalResult('run-flaky')).rejects.toThrow('unreachable');
    const pending = (await flaky.list()).find((m) => m.artifactId === artifactId)!;
    expect(pending.state).toBe('delete_pending');

    failDelete = false;
    const { removed } = await runtime.reconcileDiagnosticArtifacts();
    expect(removed).toContain(artifactId);
    await runtime.shutdown();
  });

  it('A13.17 refuses to serve an artifact whose logical expiry has passed', async () => {
    const runtime = artifactRuntime();
    const { artifactId, data } = await stagedResult(runtime, 'run-exp');
    await runtime.saveEvalResult({ id: 'run-exp', eval: 'e', timestamp: 1, data });
    // Simulate a Redis TTL that elapsed while this process was offline.
    await runtime.getDiagnosticArtifactStore()!.refreshExpiry(artifactId, Date.now() - 1);

    // Serving bytes whose owning history row has expired is the bug.
    expect(await runtime.openDiagnosticArtifact(artifactId)).toBeUndefined();
    const { removed } = await runtime.reconcileDiagnosticArtifacts();
    expect(removed).toContain(artifactId);
    await runtime.shutdown();
  });

  it('returns undefined for an artifact whose owner row is gone', async () => {
    const runtime = artifactRuntime();
    const { artifactId, data } = await stagedResult(runtime, 'run-ownerless');
    await runtime.saveEvalResult({ id: 'run-ownerless', eval: 'e', timestamp: 1, data });
    // Drop the row without going through deleteEvalResult (an out-of-band wipe).
    await runtime.getStateStore().deleteEvalResult!('run-ownerless');

    expect(await runtime.openDiagnosticArtifact(artifactId)).toBeUndefined();
    await runtime.shutdown();
  });

  it('stops the sweep timer on shutdown', async () => {
    const runtime = artifactRuntime({ sweepIntervalMs: 5 });
    await runtime.shutdown();
    const before = (await runtime.getDiagnosticArtifactStore()!.list()).length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    // A sweeper still running after shutdown would be querying a closed store.
    expect((await runtime.getDiagnosticArtifactStore()!.list()).length).toBe(before);
  });
});

// ── StateStore retention capability ──────────────────────────────────

describe('getEvalRetention', () => {
  it('MemoryStore reports existence and no expiry', async () => {
    const store = new MemoryStore();
    await store.saveEvalResult({ id: 'x', eval: 'e', timestamp: 1, data: {} });
    expect(await store.getEvalRetention('x')).toEqual({ exists: true });
    expect(await store.getEvalRetention('missing')).toEqual({ exists: false });
  });

  it('SQLiteStore reports existence and no expiry', async () => {
    const store = new SQLiteStore(path.join(root, 'r.db'));
    await store.saveEvalResult({ id: 'x', eval: 'e', timestamp: 1, data: {} });
    expect(await store.getEvalRetention('x')).toEqual({ exists: true });
    expect(await store.getEvalRetention('missing')).toEqual({ exists: false });
    await store.close();
  });
});

// ── A12.7: capture off by default stays off ──────────────────────────

describe('A12.7 — the default is genuinely no capture', () => {
  it('creates no artifact directory and requires no configuration', async () => {
    const runtime = new AxlRuntime();
    // No `diagnostics.artifacts` at all: constructing and running is fine.
    expect(runtime.getDiagnosticArtifactStore()).toBeUndefined();
    expect(await runtime.reconcileDiagnosticArtifacts()).toEqual({ removed: [] });
    await expect(runtime.openDiagnosticArtifact('anything')).resolves.toBeUndefined();

    const configured = artifactRuntime();
    await configured.saveEvalResult({
      id: 'plain',
      eval: 'e',
      timestamp: 1,
      data: { id: 'plain', totalCost: 0, items: [] },
    });
    // A result with no `diagnostics` must not mint an artifact.
    expect(await configured.getDiagnosticArtifactStore()!.list()).toEqual([]);
    await configured.shutdown();
  });
});

// ── Manifest durability ──────────────────────────────────────────────

describe('manifest durability', () => {
  it('survives a manifest that is missing or unparseable during a sweep', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    const good = await store.stage(OWNER, { leaseMs: 1000 });
    await writeFile(path.join(root, 'garbage-dir', 'manifest.json'), 'not json', {
      encoding: 'utf-8',
    }).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, 'garbage-dir'), { recursive: true });
      await writeFile(path.join(root, 'garbage-dir', 'manifest.json'), 'not json', 'utf-8');
    });

    // One corrupt directory must not strand every other artifact.
    const manifests: ArtifactManifest[] = await store.list();
    expect(manifests.map((m) => m.artifactId)).toEqual([good.artifactId]);
    expect(await readFile(path.join(root, good.artifactId, 'manifest.json'), 'utf-8')).toContain(
      good.artifactId,
    );
  });
});

// ── Adversarial review: H3, H2, M3, M5, L2 ───────────────────────────

describe('a live writer keeps its lease without writing (H3)', () => {
  /**
   * Real time, deliberately. The renewal is a timer the runtime owns and the
   * whole point of the case is that it fires with nobody calling `append` or
   * `renewLease`; a fake clock would have to be installed around the real
   * filesystem I/O the renewal itself performs. A short lease keeps the wait
   * to a few hundred milliseconds.
   */
  it('survives a sweep after it stops appending, and still finalizes with its bytes', async () => {
    const leaseMs = 150;
    const runtime = artifactRuntime({ leaseMs });
    const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: 'run-long' });

    // A run that hit `maxRunBytes` early: the channel stops writing, so nothing
    // ever calls `append` again — but the run itself keeps going for far longer
    // than a lease before it can finalize.
    const channel = new RequestCaptureChannel({ sink: staged.sink, maxRunBytes: 700 });
    for (let i = 0; i < 20; i++) {
      channel.write({
        v: 1,
        phase: 'start',
        operationId: `op_${i}`,
        kind: 'chat',
        transportAttempts: 1,
        provider: 'mock',
        model: 'mock:m',
        captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
      });
    }
    const status = await channel.close();
    expect(status.status).toBe('truncated');
    expect(status.records).toBeGreaterThan(0);

    // Several lease periods pass with no appends at all. The lease must be held
    // by the WRITER's lifetime, not by its write rate.
    await new Promise((resolve) => setTimeout(resolve, leaseMs * 4));

    const { removed } = await runtime.reconcileDiagnosticArtifacts();

    // Sweeping here destroys evidence a live run is still holding, and the run
    // then cannot even finalize the artifact it had been filling.
    expect(removed).toEqual([]);
    const manifest = await runtime.finalizeDiagnosticArtifact(staged.artifactId, 'truncated');
    expect(manifest.status).toBe('truncated');
    expect(manifest.records).toBe(status.records);
    expect(manifest.bytes).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  it('stops renewing once the artifact is finalized', async () => {
    const leaseMs = 150;
    const runtime = artifactRuntime({ leaseMs });
    const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: 'run-done' });
    await staged.sink.append('{"v":1}');
    await runtime.finalizeDiagnosticArtifact(staged.artifactId, 'complete');

    // Finalized and never saved: an orphan now, and a renewal timer that
    // outlived its writer would keep it alive forever.
    await new Promise((resolve) => setTimeout(resolve, leaseMs * 4));

    const { removed } = await runtime.reconcileDiagnosticArtifacts();
    expect(removed).toContain(staged.artifactId);
    await runtime.shutdown();
  });
});

describe('an entry may only act on the artifact it owns (H2)', () => {
  it("refuses to commit or delete another run's artifact", async () => {
    const runtime = artifactRuntime();
    const source = await stagedResult(runtime, 'run-source');
    await runtime.saveEvalResult({
      id: 'run-source',
      eval: 'e',
      timestamp: 1,
      data: source.data,
    });

    // A second result naming the FIRST result's artifact — the shape a degraded
    // rescore or a hand-edited import produces.
    const impostor = {
      id: 'run-impostor',
      totalCost: 0,
      items: [],
      diagnostics: { artifactId: source.artifactId, status: 'complete' },
    };
    await runtime.saveEvalResult({
      id: 'run-impostor',
      eval: 'e',
      timestamp: 2,
      data: impostor,
    });

    // The impostor's stored pointer is corrected rather than honoured.
    expect(impostor.diagnostics.artifactId).toBe('');
    expect(impostor.diagnostics.status).toBe('unavailable');

    expect(await runtime.deleteEvalResult('run-impostor')).toBe(true);

    // The source's evidence is untouched — deleting one result must never
    // destroy another's.
    const store = runtime.getDiagnosticArtifactStore()!;
    expect(await store.open(source.artifactId)).toBeDefined();
    expect(await runtime.openDiagnosticArtifact(source.artifactId)).toBeDefined();
    await runtime.shutdown();
  });
});

describe('a failed row delete leaves no deletion intent (M3)', () => {
  it('keeps the artifact when the history row could not be removed', async () => {
    const store = new MemoryStore() as MemoryStore & {
      deleteEvalResult(id: string): Promise<boolean>;
    };
    const runtime = artifactRuntime({ store });
    const saved = await stagedResult(runtime, 'run-keep');
    await runtime.saveEvalResult({ id: 'run-keep', eval: 'e', timestamp: 1, data: saved.data });
    store.deleteEvalResult = async () => {
      throw new Error('state store unreachable');
    };

    await expect(runtime.deleteEvalResult('run-keep')).rejects.toThrow('unreachable');

    // The caller was told the delete failed. A `delete_pending` intent written
    // before the row would have the sweeper destroy the evidence anyway.
    const artifacts = runtime.getDiagnosticArtifactStore()!;
    const manifest = (await artifacts.list()).find((m) => m.artifactId === saved.artifactId)!;
    expect(manifest.state).toBe('committed');
    const { removed } = await runtime.reconcileDiagnosticArtifacts();
    expect(removed).not.toContain(saved.artifactId);
    await runtime.shutdown();
  });
});

describe('a vanished artifact is reported, not published (M5)', () => {
  it('downgrades the stored result when the artifact is already gone', async () => {
    const runtime = artifactRuntime();
    const staged = await stagedResult(runtime, 'run-gone');
    // Swept, or removed out of band, between finalize and save.
    await runtime.getDiagnosticArtifactStore()!.delete(staged.artifactId);

    await runtime.saveEvalResult({ id: 'run-gone', eval: 'e', timestamp: 1, data: staged.data });

    const stored = (await runtime.getEvalHistory()).find((e) => e.id === 'run-gone')!;
    const diagnostics = (stored.data as { diagnostics: Record<string, unknown> }).diagnostics;
    // Persisting `complete` with a dangling id is the fail-quietly bug.
    expect(diagnostics.status).toBe('unavailable');
    expect(diagnostics.artifactId).toBe('');
    expect(diagnostics.reason).toBeTruthy();
    await runtime.shutdown();
  });

  it('reports a missing artifact from commit, markDeletePending and refreshExpiry', async () => {
    const store = new FileDiagnosticArtifactStore({ root });
    expect(await store.commit('art_nope', {})).toEqual({ ok: false, reason: 'missing' });
    expect(await store.markDeletePending('art_nope')).toEqual({ ok: false, reason: 'missing' });
    expect(await store.refreshExpiry('art_nope', 1)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('one history entry can be read without the rest (L5)', () => {
  it('returns the entry by id, and undefined for one that is not there', async () => {
    const runtime = artifactRuntime();
    const saved = await stagedResult(runtime, 'run-byid');
    await runtime.saveEvalResult({ id: 'run-byid', eval: 'e', timestamp: 1, data: saved.data });
    await runtime.saveEvalResult({ id: 'other', eval: 'e', timestamp: 2, data: { id: 'other' } });

    const entry = await runtime.getEvalResult('run-byid');
    expect(entry?.id).toBe('run-byid');
    expect(entry?.data).toBe(saved.data);
    expect(await runtime.getEvalResult('never-saved')).toBeUndefined();
    await runtime.shutdown();
  });
});

describe('only a committed artifact is readable through the runtime (L2)', () => {
  it('refuses a staged artifact', async () => {
    const runtime = artifactRuntime();
    const staged = await stagedResult(runtime, 'run-staged');

    // Finalized but never saved: no history row owns it yet, so nothing may
    // serve it through an ownership-checked path.
    expect(await runtime.openDiagnosticArtifact(staged.artifactId)).toBeUndefined();
    // The store itself still reads it — that is how the CLI writes a standalone
    // sidecar for a run it never persisted.
    expect(await runtime.getDiagnosticArtifactStore()!.open(staged.artifactId)).toBeDefined();
    await runtime.shutdown();
  });
});
