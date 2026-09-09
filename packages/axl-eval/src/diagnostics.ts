/**
 * The eval side of opt-in request capture: the JSONL codec, the manifest an
 * `EvalResult` carries, and the bundle validation that keeps an imported
 * artifact from naming anything but an artifact id.
 *
 * The division of labour with the core is deliberate. `@axlsdk/axl` owns the
 * measurement-adjacent parts — snapshotting the request before dispatch,
 * redaction, byte bounds, the non-blocking queue, and the artifact lifecycle —
 * because all of those must hold for ANY consumer of `trackOutcome`, not just
 * evals. This module owns what is eval-shaped: which run/case/scorer a record
 * belongs to, how a run reports what it managed to capture, and what an
 * exported bundle is allowed to contain.
 *
 * `RequestRecord` is the core record type by alias rather than by copy. Two
 * hand-maintained declarations of a wire format drift, and the drift is
 * invisible until someone tries to read last month's artifact.
 */

import type { ArtifactManifest, CapturedRequestRecord } from '@axlsdk/axl';

/** One JSONL line of a captured-request artifact. Codec version 1. */
export type RequestRecord = CapturedRequestRecord;

/**
 * A pointer from an item or a scorer to one captured operation.
 *
 * `status` is the honest part: `'recorded'` is a complete request/response
 * pair, `'start_only'` is a call that never came back (the one you most want
 * to see), `'truncated'` is a record replaced by a stub because it exceeded the
 * per-record byte bound, and `'omitted'` is an operation capture never reached.
 */
export type OperationRef = {
  operationId: string;
  kind: 'chat' | 'stream';
  turn?: number;
  attempt?: number;
  status: 'recorded' | 'start_only' | 'truncated' | 'omitted';
};

/** What an `EvalResult` says about its captured requests. */
export type DiagnosticManifest = {
  version: 1;
  artifactId: string;
  fidelity: 'runtime_request';
  status: ArtifactManifest['status'];
  reason?: string;
  records: number;
  bytes: number;
  redaction: 'applied' | 'none';
  expiresAt?: number;
};

/** Per-run capture limits, as `runEval`/`rescore` accept them. */
export type CaptureRequestsOption =
  | boolean
  | {
      maxRecordBytes?: number;
      maxRunBytes?: number;
      maxQueueBytes?: number;
    };

/**
 * Default bytes a rescore may copy from the source run's artifact.
 *
 * The same ceiling as a run's own capture budget: a rescore's copied evidence
 * should never be able to dwarf the evidence a fresh run is allowed to produce.
 */
export const DEFAULT_COPY_MAX_BYTES = 16 * 1024 * 1024;

/** Normalize the option into explicit limits, or `undefined` when capture is off. */
export function resolveCaptureLimits(
  option: CaptureRequestsOption | undefined,
): { maxRecordBytes?: number; maxRunBytes?: number; maxQueueBytes?: number } | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return {};
  return {
    ...(option.maxRecordBytes !== undefined ? { maxRecordBytes: option.maxRecordBytes } : {}),
    ...(option.maxRunBytes !== undefined ? { maxRunBytes: option.maxRunBytes } : {}),
    ...(option.maxQueueBytes !== undefined ? { maxQueueBytes: option.maxQueueBytes } : {}),
  };
}

/** Build the result-level manifest from the store's finalized manifest. */
export function toDiagnosticManifest(manifest: ArtifactManifest): DiagnosticManifest {
  return {
    version: 1,
    artifactId: manifest.artifactId,
    fidelity: 'runtime_request',
    status: manifest.status,
    ...(manifest.reason !== undefined ? { reason: manifest.reason } : {}),
    records: manifest.records,
    bytes: manifest.bytes,
    redaction: manifest.redaction,
    ...(manifest.expiresAt !== undefined ? { expiresAt: manifest.expiresAt } : {}),
  };
}

/** A manifest for a run whose capture could not be produced at all. */
export function unavailableManifest(artifactId: string, reason: string): DiagnosticManifest {
  return {
    version: 1,
    artifactId,
    fidelity: 'runtime_request',
    status: 'unavailable',
    reason,
    records: 0,
    bytes: 0,
    redaction: 'none',
  };
}

// ---------------------------------------------------------------------------
// Bundle validation (import path)
// ---------------------------------------------------------------------------

/** Default ceiling on an imported `.requests.jsonl` sidecar. */
export const DEFAULT_SIDECAR_MAX_BYTES = 16 * 1024 * 1024;

export type SidecarValidation =
  | { ok: true; lines: string[]; bytes: number }
  | { ok: false; reason: string };

/**
 * Validate an imported JSONL sidecar before a single byte of it is stored.
 *
 * Imports are the one place where a stranger's JSON reaches this subsystem, so
 * the rules are deliberately narrow: every line must parse, must declare `v: 1`,
 * and must carry the identity fields a reader indexes on. Anything else — a
 * `file://` reference, a `path` field, a record for a codec version we cannot
 * interpret — is refused rather than stored and puzzled over later.
 *
 * Note what is NOT here: nothing in a record can name a filesystem path or a
 * URL to fetch, because the reader never dereferences anything. Records are
 * re-staged under a NEW artifact id owned by the NEW history row, so an
 * imported reference can only ever point at bytes this runtime wrote itself.
 */
export function validateRequestSidecar(
  text: unknown,
  options?: { maxBytes?: number },
): SidecarValidation {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'requests sidecar must be a JSONL string' };
  }
  const maxBytes = options?.maxBytes ?? DEFAULT_SIDECAR_MAX_BYTES;
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > maxBytes) {
    return { ok: false, reason: `requests sidecar exceeds ${maxBytes} bytes` };
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      return { ok: false, reason: `requests sidecar line ${i + 1} is not valid JSON` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `requests sidecar line ${i + 1} is not an object` };
    }
    const record = parsed as Partial<RequestRecord>;
    if (record.v !== 1) {
      return {
        ok: false,
        reason: `requests sidecar line ${i + 1} declares unsupported codec version ${String(record.v)}`,
      };
    }
    if (typeof record.operationId !== 'string' || record.operationId === '') {
      return { ok: false, reason: `requests sidecar line ${i + 1} has no operationId` };
    }
    if (record.phase !== 'start' && record.phase !== 'attempt' && record.phase !== 'end') {
      return { ok: false, reason: `requests sidecar line ${i + 1} has an unknown phase` };
    }
  }
  return { ok: true, lines, bytes };
}

/** Parse a validated sidecar into records. */
export function parseRequestRecords(lines: readonly string[]): RequestRecord[] {
  return lines.map((line) => JSON.parse(line) as RequestRecord);
}

/** Encode records back into a sidecar body. */
export function serializeRequestRecords(records: readonly RequestRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
