/**
 * Diagnostic artifact storage — the durable side of opt-in request capture.
 *
 * Captured request records are far too large to live inside an eval result, so
 * they live beside it as an **artifact**: an opaque id owned by an eval history
 * entry, holding a JSONL stream of records plus a small manifest describing
 * what the capture actually managed to record.
 *
 * The lifecycle is deliberately two-phase, because the artifact and the history
 * row are written to different stores and either write can fail:
 *
 * ```
 *   stage(owner)  →  append(...)*  →  finalize(status)  →  [save history]  →  commit(expiresAt)
 *                                                       ↘ (save threw)  →  rollback()
 * ```
 *
 * A `staged` artifact is never served and is reclaimed once its lease expires,
 * so a process that dies mid-run leaves recoverable bytes rather than a
 * permanent orphan. Only a `committed` artifact whose owner still exists and
 * whose logical expiry has not passed is readable.
 *
 * Deletion is also two-phase: `markDeletePending` records the intent, then
 * `delete` removes the bytes. A failure between the two leaves the intent
 * behind, so a later `reconcile` finishes the job without the caller having to
 * re-supply anything.
 *
 * The interface is the extension point: a host running Redis history (whose
 * server-side TTL cannot notify a local filesystem) supplies its own
 * implementation. {@link FileDiagnosticArtifactStore} is the only built-in
 * backend, and Axl never silently falls back to a process temp folder.
 */

import { createReadStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { AxlError } from '../errors.js';

/** Who an artifact belongs to. Today only an eval history entry can own one. */
export type ArtifactOwner = {
  kind: 'eval';
  /** The eval history entry id (`EvalHistoryEntry.id`). */
  id: string;
};

/** How completely a capture managed to record what it was asked to record. */
export type ArtifactStatus =
  /** Every record the run produced was written. */
  | 'complete'
  /** A byte/queue bound stopped capture partway; `reason` says which. */
  | 'truncated'
  /** The writer never finalized (process death). Bytes are readable but partial. */
  | 'interrupted'
  /** The sink failed; there may be no usable bytes at all. `reason` says why. */
  | 'unavailable';

/** The versioned descriptor written beside every artifact's records. */
export type ArtifactManifest = {
  version: 1;
  artifactId: string;
  owner: ArtifactOwner;
  state: 'staged' | 'committed' | 'delete_pending';
  /** Records actually written (including truncation stubs). */
  records: number;
  /** UTF-8 bytes of the written record lines. */
  bytes: number;
  status: ArtifactStatus;
  reason?: string;
  /** What the captured requests represent. Never provider wire bytes. */
  fidelity: 'runtime_request';
  redaction: 'applied' | 'none';
  createdAt: number;
  committedAt?: number;
  /** Absolute logical expiry, mirrored from the owning history row's retention. */
  expiresAt?: number;
  /** While `staged`: the deadline after which an abandoned writer is reclaimed. */
  leaseUntil?: number;
  /** Provenance when a rescore copied this artifact from another run's. */
  copiedFrom?: { artifactId: string; ownerId: string };
};

/** A staged artifact, held open by a renewable lease while its writer runs. */
export type StagedArtifact = {
  artifactId: string;
  /** Push the lease deadline out. Call periodically from a long-running writer. */
  renewLease(): Promise<void>;
};

/** An opened artifact: its manifest plus a lazily-read stream of JSONL lines. */
export type OpenedArtifact = {
  manifest: ArtifactManifest;
  lines: AsyncIterable<string>;
};

/**
 * The storage contract for diagnostic artifacts.
 *
 * Every method is idempotent where that is meaningful: deleting an unknown id
 * succeeds, marking delete-pending twice succeeds, and rolling back an
 * already-gone artifact succeeds. Keys are opaque ids the store mints — a
 * caller never supplies a path or a URL, which is what keeps an imported
 * artifact reference from naming an arbitrary file.
 */
export interface DiagnosticArtifactStore {
  /** Reserve a new artifact id for `owner`, held by a lease of `leaseMs`. */
  stage(owner: ArtifactOwner, opts: { leaseMs: number }): Promise<StagedArtifact>;
  /** Append one already-encoded JSONL record. The caller pre-bounds its size. */
  append(artifactId: string, line: string): Promise<void>;
  /** Seal the record stream and record how complete it is. */
  finalize(artifactId: string, status: ArtifactStatus, reason?: string): Promise<ArtifactManifest>;
  /** Promote a finalized artifact to `committed` once its owner row exists. */
  commit(artifactId: string, opts: { expiresAt?: number }): Promise<void>;
  /** Discard a staged artifact entirely (its owner row was never written). */
  rollback(artifactId: string): Promise<void>;
  /** Read a committed (or interrupted) artifact, or `undefined` if absent. */
  open(artifactId: string): Promise<OpenedArtifact | undefined>;
  /** Copy `sourceId`'s records under a new id owned by `owner`, bounded by bytes. */
  copy(
    sourceId: string,
    owner: ArtifactOwner,
    opts: { maxBytes: number; leaseMs: number },
  ): Promise<{ artifactId: string; truncated: boolean } | undefined>;
  /** Record an idempotent deletion intent before the owner row is removed. */
  markDeletePending(artifactId: string): Promise<void>;
  /** Physically remove an artifact. Idempotent. */
  delete(artifactId: string): Promise<void>;
  /** Every manifest the store holds. */
  list(): Promise<ArtifactManifest[]>;
  /** Rewrite an artifact's logical expiry (its owner row was re-saved). */
  refreshExpiry(artifactId: string, expiresAt: number | undefined): Promise<void>;
}

const MANIFEST_FILE = 'manifest.json';
const RECORDS_FILE = 'records.jsonl';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * The built-in filesystem backend: one directory per artifact under `root`,
 * holding `manifest.json` and `records.jsonl`.
 *
 * Manifest writes go through a temp file and a rename, so a crash mid-write
 * leaves either the previous manifest or the new one — never a half-parsed
 * JSON document that would make the artifact unreadable and unreclaimable.
 * Record appends are serialized per artifact through a promise chain so
 * concurrent writers cannot interleave partial lines.
 */
export class FileDiagnosticArtifactStore implements DiagnosticArtifactStore {
  private readonly root: string;
  /** Per-artifact serialization chain for appends. */
  private readonly writeChains = new Map<string, Promise<void>>();
  /** Live byte/record counters, folded into the manifest at finalize. */
  private readonly counters = new Map<string, { records: number; bytes: number }>();

  constructor(options: { root: string }) {
    const root = options?.root;
    if (typeof root !== 'string' || root.trim() === '') {
      throw new AxlError(
        'INVALID_CONFIG',
        'FileDiagnosticArtifactStore requires a non-empty `root` directory path.',
      );
    }
    this.root = path.resolve(root);
  }

  private dir(artifactId: string): string {
    // Artifact ids are minted here and never supplied by a caller, but a
    // traversal guard is cheap insurance against a hand-written id reaching
    // `open`/`delete` from an imported artifact reference.
    const dir = path.resolve(this.root, artifactId);
    if (dir !== path.join(this.root, path.basename(dir))) {
      throw new AxlError('INVALID_CONFIG', `Invalid diagnostic artifact id "${artifactId}".`);
    }
    return dir;
  }

  private async readManifest(artifactId: string): Promise<ArtifactManifest | undefined> {
    try {
      const raw = await readFile(path.join(this.dir(artifactId), MANIFEST_FILE), 'utf-8');
      return JSON.parse(raw) as ArtifactManifest;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Atomic manifest replacement: write a sibling temp file, then rename over. */
  private async writeManifest(manifest: ArtifactManifest): Promise<void> {
    const dir = this.dir(manifest.artifactId);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `${MANIFEST_FILE}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(manifest), 'utf-8');
    await rename(temp, path.join(dir, MANIFEST_FILE));
  }

  private async mutate(
    artifactId: string,
    change: (manifest: ArtifactManifest) => ArtifactManifest,
  ): Promise<ArtifactManifest | undefined> {
    const manifest = await this.readManifest(artifactId);
    if (!manifest) return undefined;
    const next = change(manifest);
    await this.writeManifest(next);
    return next;
  }

  async stage(owner: ArtifactOwner, opts: { leaseMs: number }): Promise<StagedArtifact> {
    const artifactId = `art_${randomUUID()}`;
    const now = Date.now();
    await this.writeManifest({
      version: 1,
      artifactId,
      owner,
      state: 'staged',
      records: 0,
      bytes: 0,
      status: 'interrupted',
      fidelity: 'runtime_request',
      redaction: 'none',
      createdAt: now,
      leaseUntil: now + opts.leaseMs,
    });
    this.counters.set(artifactId, { records: 0, bytes: 0 });
    return {
      artifactId,
      renewLease: async () => {
        await this.mutate(artifactId, (m) => ({ ...m, leaseUntil: Date.now() + opts.leaseMs }));
      },
    };
  }

  async append(artifactId: string, line: string): Promise<void> {
    const file = path.join(this.dir(artifactId), RECORDS_FILE);
    const previous = this.writeChains.get(artifactId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await appendFile(file, `${line}\n`, 'utf-8');
        const counter = this.counters.get(artifactId) ?? { records: 0, bytes: 0 };
        counter.records += 1;
        counter.bytes += Buffer.byteLength(line, 'utf-8');
        this.counters.set(artifactId, counter);
      });
    this.writeChains.set(artifactId, next);
    await next;
  }

  async finalize(
    artifactId: string,
    status: ArtifactStatus,
    reason?: string,
  ): Promise<ArtifactManifest> {
    await this.writeChains.get(artifactId)?.catch(() => undefined);
    const counter = this.counters.get(artifactId) ?? { records: 0, bytes: 0 };
    const finalized = await this.mutate(artifactId, (m) => ({
      ...m,
      status,
      ...(reason !== undefined ? { reason } : {}),
      records: counter.records,
      bytes: counter.bytes,
    }));
    if (!finalized) {
      throw new AxlError(
        'DIAGNOSTICS_UNAVAILABLE',
        `Diagnostic artifact "${artifactId}" no longer exists and cannot be finalized.`,
      );
    }
    return finalized;
  }

  async commit(artifactId: string, opts: { expiresAt?: number }): Promise<void> {
    await this.mutate(artifactId, (m) => {
      const next: ArtifactManifest = {
        ...m,
        state: 'committed',
        committedAt: Date.now(),
      };
      delete next.leaseUntil;
      if (opts.expiresAt !== undefined) next.expiresAt = opts.expiresAt;
      else delete next.expiresAt;
      return next;
    });
    this.writeChains.delete(artifactId);
    this.counters.delete(artifactId);
  }

  async rollback(artifactId: string): Promise<void> {
    await this.delete(artifactId);
  }

  async open(artifactId: string): Promise<OpenedArtifact | undefined> {
    const manifest = await this.readManifest(artifactId);
    if (!manifest) return undefined;
    // No status rewriting here. `stage` writes `status: 'interrupted'` up front
    // and `finalize` overwrites it, so a writer that died before finalizing
    // ALREADY reports `interrupted` — and its records are still readable up to
    // the truncation point. Overriding on `state === 'staged'` instead would
    // misreport a deliberately-staged artifact (the CLI's standalone bundle,
    // which is finalized but never committed to history) as interrupted.
    const file = path.join(this.dir(artifactId), RECORDS_FILE);
    return {
      manifest,
      lines: {
        async *[Symbol.asyncIterator](): AsyncIterator<string> {
          let stream;
          try {
            await stat(file);
            stream = createReadStream(file, { encoding: 'utf-8' });
          } catch (error) {
            if (isMissing(error)) return;
            throw error;
          }
          const reader = createInterface({ input: stream, crlfDelay: Infinity });
          try {
            for await (const line of reader) {
              if (line.trim() !== '') yield line;
            }
          } finally {
            reader.close();
            stream.destroy();
          }
        },
      },
    };
  }

  async copy(
    sourceId: string,
    owner: ArtifactOwner,
    opts: { maxBytes: number; leaseMs: number },
  ): Promise<{ artifactId: string; truncated: boolean } | undefined> {
    const source = await this.open(sourceId);
    if (!source) return undefined;
    const staged = await this.stage(owner, { leaseMs: opts.leaseMs });
    let bytes = 0;
    let truncated = false;
    for await (const line of source.lines) {
      const size = Buffer.byteLength(line, 'utf-8');
      if (bytes + size > opts.maxBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      await this.append(staged.artifactId, line);
    }
    await this.mutate(staged.artifactId, (m) => ({
      ...m,
      redaction: source.manifest.redaction,
      copiedFrom: { artifactId: sourceId, ownerId: source.manifest.owner.id },
    }));
    return { artifactId: staged.artifactId, truncated };
  }

  async markDeletePending(artifactId: string): Promise<void> {
    await this.mutate(artifactId, (m) => ({ ...m, state: 'delete_pending' }));
  }

  async delete(artifactId: string): Promise<void> {
    await this.writeChains.get(artifactId)?.catch(() => undefined);
    this.writeChains.delete(artifactId);
    this.counters.delete(artifactId);
    await rm(this.dir(artifactId), { recursive: true, force: true });
  }

  async list(): Promise<ArtifactManifest[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const manifests: ArtifactManifest[] = [];
    for (const entry of entries) {
      // A directory whose manifest is missing or unparseable is skipped rather
      // than crashing the sweep for every other artifact. Reconciliation
      // reclaims it by lease expiry on a later pass once the manifest lands.
      try {
        const manifest = await this.readManifest(entry);
        if (manifest) manifests.push(manifest);
      } catch {
        continue;
      }
    }
    return manifests;
  }

  async refreshExpiry(artifactId: string, expiresAt: number | undefined): Promise<void> {
    await this.mutate(artifactId, (m) => {
      const next = { ...m };
      if (expiresAt !== undefined) next.expiresAt = expiresAt;
      else delete next.expiresAt;
      return next;
    });
  }
}
