import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AxlConfig } from './config.js';
import { parseCost, resolveConfig } from './config.js';
import type { Workflow, AnyWorkflow } from './workflow.js';
import type { Tool } from './tool.js';
import type { Agent } from './agent.js';
import type { Provider } from './providers/types.js';
import { buildSummaryPrompt, requestSummary } from './compaction.js';
import { ProviderRegistry } from './providers/registry.js';
import { TranscriptionProviderRegistry } from './providers/transcription-registry.js';
import type { TranscriptionProvider } from './providers/transcription-types.js';
import type { StateStore, PendingDecision, EvalHistoryEntry } from './state/types.js';
import { MemoryStore } from './state/memory.js';
import { SQLiteStore } from './state/sqlite.js';
import {
  parseHumanDecision,
  resolveBranchDrainTimeoutMs,
  WorkflowContext,
  type PendingDecisionResolver,
} from './context.js';
import { Session, type SessionOptions } from './session.js';
import { AxlStream } from './stream.js';
import type { EventStreamOptions } from './event-stream.js';
import { McpManager } from './mcp/manager.js';
import { MemoryManager } from './memory/manager.js';
import type {
  AxlEvent,
  AxlEventV2,
  ExecutionInfo,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  LegacyAxlEventV1,
  HumanDecision,
  AwaitHumanOptions,
  ChatMessage,
  HandoffRecord,
  CallTiming,
} from './types.js';
import { AxlError, preserveErrorCause } from './errors.js';
import {
  getEventSchemaVersion,
  normalizeStoredExecution as normalizeHistoricalExecution,
} from './event-schema.js';
import { eventCostContribution, isUnpricedLeaf } from './event-utils.js';
import {
  runInAccountingScope,
  type Accounting,
  type AdmissionController,
  type OperationPurpose,
  type SettlementDiagnostics,
} from './accounting.js';
import { createScopedProvider } from './providers/scoped-provider.js';
import {
  FileDiagnosticArtifactStore,
  type ArtifactManifest,
  type ArtifactOwner,
  type ArtifactStatus,
  type DiagnosticArtifactStore,
  type OpenedArtifact,
  type StagedArtifact,
} from './diagnostics/artifact-store.js';
import {
  RequestCaptureChannel,
  runWithCaptureChannel,
  runWithCaptureCorrelation,
  type CaptureCorrelation,
  type RequestCaptureSink,
} from './diagnostics/capture.js';
import { NoopSpanManager } from './telemetry/noop.js';
import { createSpanManager } from './telemetry/index.js';
import type { SpanManager, SpanHandle } from './telemetry/types.js';

/**
 * Function exported from an eval module that overrides the default
 * `runtime.execute(workflow, input)` behavior. The runtime injects itself as
 * the second argument so user code can call `runtime.createContext()` etc.
 *
 * Returns `{ output, cost?, metadata? }`. Both extras are optional and purely
 * informational: since 0.24 the eval runner MEASURES spend on the accounting
 * rail, so a `cost` reported here is recorded as a caller claim
 * (`EvalItem.callerReport`) and never becomes a run total. Reserved diagnostic
 * metadata keys (`models`, `tokens`, …) are likewise kept apart from the
 * runtime's own.
 *
 * Single source of truth for the eval-execution contract; consumed by
 * `registerEval`, `getRegisteredEval`, the `axl-eval` CLI, and
 * `@axlsdk/studio`'s eval-loader.
 */
export type EvalExecuteWorkflow = (
  input: unknown,
  runtime?: AxlRuntime,
) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>;

/** Simple DJB2 hash of input for span correlation. */
function hashInput(input: unknown): string {
  const str = JSON.stringify(input) ?? '';
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Default cap on `ExecutionInfo.events` per execution. Can be
 *  overridden via `config.state.maxEventsPerExecution`. */
const DEFAULT_MAX_EVENTS_PER_EXECUTION = 50_000;
const DEFAULT_STREAMING_BATCH_SIZE = 100;
const DEFAULT_STREAMING_BATCH_INTERVAL = 1_000; // ms
/** How often orphaned/expired diagnostic artifacts are reclaimed. */
const DEFAULT_ARTIFACT_SWEEP_MS = 60_000;
/** How long an actively-written (staged) artifact is protected from the sweep. */
const DEFAULT_ARTIFACT_LEASE_MS = 300_000;
/** How long one artifact's lease is renewed before the runtime gives up on it. */
const DEFAULT_ARTIFACT_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
/** How many dropped eval history ids the runtime remembers. See `deletedEvalIds`. */
const DELETED_EVAL_MEMORY = 1024;
/**
 * One warning per process for a store that cannot do a retention-neutral
 * update. It is a static misconfiguration — a Redis older than 6.0 — so every
 * later correction would repeat the same line, and corrections fire on a timer.
 */
let warnedUpdateUnsupported = false;

/** Sentinel workflow name on synthesized ExecutionInfos when the streaming
 *  buffer doesn't include a `workflow_start` event. The `__axl/` prefix
 *  marks it as a system-generated value so list-by-workflow consumers can
 *  filter or group it distinctly from user workflows. */
const RECOVERED_UNKNOWN_WORKFLOW = '__axl/recovered';

/**
 * High-volume stream-only event types that are NEVER persisted to:
 *   1. `ExecutionInfo.events` (in-memory canonical array) — filtered by
 *      `pushEventBounded`.
 *   2. The streaming-mode Redis buffer — filtered by `StreamingFlusher.append`.
 *   3. Studio's WS replay buffer (separate constant
 *      `UNBUFFERED_EVENT_TYPES` in `connection-manager.ts`, kept in sync
 *      with this list deliberately — the two serve the same purpose at
 *      different layers).
 *
 * Including these would multiply Redis traffic by 10–100× for no recovery
 * benefit: token streams can be reconstructed from the persisted
 * `agent_call_end.data.response`, partial objects from `agent_call_end.data`,
 * and `string_delta` is incremental UI state with no value post-crash.
 */
const STREAMING_EXCLUDED_TYPES: ReadonlySet<string> = new Set([
  'token',
  'partial_object',
  'string_delta',
]);

/**
 * Keys inside `ExecuteOptions.metadata` that are control-plane fields the
 * runtime consumes during `execute()` / `stream()` — NOT user tags. We strip
 * them before lifting `metadata` onto `ExecutionInfo.metadata` so:
 *   - large session-history buffers don't bloat the persisted blob,
 *   - `sessionId` doesn't leak into queryable surfaces,
 *   - the persisted shape is stable user-facing metadata (tags, tenantId,
 *     correlation ids) rather than a grab-bag of internal options.
 *
 * Callers using these keys for control-plane purposes still see them on
 * `ctx.metadata` and dynamic selector callbacks — only the persisted snapshot
 * is filtered.
 */
const INTERNAL_METADATA_KEYS: ReadonlySet<string> = new Set(['sessionId', 'sessionHistory']);

/**
 * Filter internal control-plane keys out of `ExecuteOptions.metadata` and
 * return a fresh object suitable for assignment to `ExecutionInfo.metadata`.
 *
 * `structuredClone` isolates the snapshot from caller mutations after
 * `execute()` / `stream()` returns — otherwise `getExecution(id)` mid-run
 * would surface live mutations to anyone holding a reference to the original
 * `options.metadata` object.
 */
function liftPersistedMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const filtered: Record<string, unknown> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(metadata)) {
    if (INTERNAL_METADATA_KEYS.has(k)) continue;
    filtered[k] = v;
    hasAny = true;
  }
  if (!hasAny) return undefined;
  try {
    return structuredClone(filtered);
  } catch {
    // Non-cloneable value in metadata (e.g., a function). Fall back to a
    // shallow copy — the caller's tags are unlikely to contain non-cloneable
    // data, but we'd rather degrade than crash the workflow on an exotic
    // entry.
    return { ...filtered };
  }
}

/**
 * Per-execution streaming-event buffer with size-and-time-bounded flushes.
 *
 * Lifecycle:
 *   1. `append(executionId, event)` is called on every emitted event. The
 *      event is added to the per-execution buffer; if the buffer reaches
 *      `batchSize`, it flushes immediately. Otherwise a timer is armed to
 *      flush after `batchInterval` ms.
 *   2. `finalize(executionId)` is called by the runtime's terminal path
 *      AFTER the canonical `executionHistory` has been saved. It flushes
 *      any remaining buffer + calls `stateStore.finalizeStreamingEvents`
 *      to release the per-execution buffer in the store.
 *   3. `flushAll()` is called on `runtime.shutdown()` — best-effort drain
 *      so an orderly shutdown doesn't lose the last 1s of events.
 *
 * Failure posture: flush errors are caught and logged (`console.error`),
 * NOT propagated — the workflow's hot path must not crash because the
 * streaming store is temporarily unavailable. The buffer is dropped on
 * flush failure to bound memory; users who need exactly-once delivery
 * should configure their backing store for high availability.
 */
class StreamingFlusher {
  private buffers = new Map<string, AxlEvent[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Tracks the most recent in-flight `appendStreamingEvents` per execution
   * so `finalize` can await it. Without this, a size-triggered fire-and-
   * forget flush whose RPUSH lands AFTER `finalize`'s DEL would resurrect
   * the buffer + re-register the execution in the streaming-exec-ids set
   * — a phantom orphan that recoverIncompleteStreams would later mis-recover.
   */
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private store: StateStore,
    private batchSize: number,
    private batchInterval: number,
  ) {}

  append(executionId: string, event: AxlEvent): void {
    if (STREAMING_EXCLUDED_TYPES.has(event.type)) return;

    let buffer = this.buffers.get(executionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(executionId, buffer);
    }
    buffer.push(event);

    if (buffer.length >= this.batchSize) {
      // Synchronous flush trigger; the actual write is async via Promise.
      // The returned Promise is registered in `inflight` so finalize can
      // await it.
      void this.flush(executionId);
      return;
    }

    // Arm a timer if one isn't already armed for this execution
    if (!this.timers.has(executionId)) {
      const timer = setTimeout(() => {
        this.timers.delete(executionId);
        void this.flush(executionId);
      }, this.batchInterval);
      // Don't block process exit on the timer
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
      this.timers.set(executionId, timer);
    }
  }

  /** Flush this execution's buffer immediately. Awaits any prior in-flight
   *  flush for the same execution so writes land in order. */
  async flush(executionId: string): Promise<void> {
    const buffer = this.buffers.get(executionId);
    if (!buffer || buffer.length === 0) return;
    // Swap the buffer atomically (synchronously) so concurrent appends
    // go to a fresh array, not the one we're about to write.
    this.buffers.set(executionId, []);
    // Cancel any pending timer for this execution (we just flushed)
    const timer = this.timers.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(executionId);
    }
    // Chain after any prior in-flight write so order is preserved AND so
    // `finalize` only needs to await the most recent promise to wait on
    // all pending writes. The chain's `.finally` evicts ITS OWN entry from
    // `inflight` so settled-and-not-superseded entries don't accumulate
    // across an idle runtime (memory leak avoidance).
    const prior = this.inflight.get(executionId) ?? Promise.resolve();
    const next = prior.then(async () => {
      try {
        await this.store.appendStreamingEvents?.(executionId, buffer);
      } catch (err) {
        // Workflow hot path must not crash on a streaming-store hiccup.
        // Log and drop — exactly-once delivery is not promised here.

        console.error(
          `[axl] StreamingFlusher: failed to append ${buffer.length} events for ` +
            `executionId=${executionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    this.inflight.set(executionId, next);
    next.finally(() => {
      // Only evict if WE are still the head — a later flush() may have
      // overwritten us with a fresh chain, and we mustn't drop that.
      if (this.inflight.get(executionId) === next) {
        this.inflight.delete(executionId);
      }
    });
    return next;
  }

  /** Finalize an execution — flush remaining buffer + release store-side buffer.
   *  Critically, awaits the most recent in-flight `appendStreamingEvents` BEFORE
   *  calling `finalizeStreamingEvents`, so a late-landing RPUSH can't resurrect
   *  the buffer after we've deleted it. */
  async finalize(executionId: string): Promise<void> {
    await this.flush(executionId);
    // Drain any prior in-flight writes BEFORE deleting the store-side buffer.
    // `flush` updated `inflight` to chain after the prior write; awaiting that
    // promise covers ALL pending writes (they're chained). The chain itself
    // never rejects — failures inside `appendStreamingEvents` are caught and
    // logged at the source, so `await pending` here is non-throwing.
    const pending = this.inflight.get(executionId);
    if (pending) {
      await pending;
      this.inflight.delete(executionId);
    }
    // Drop any in-memory state for this execution
    this.buffers.delete(executionId);
    const timer = this.timers.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(executionId);
    }
    try {
      await this.store.finalizeStreamingEvents?.(executionId);
    } catch (err) {
      console.error(
        `[axl] StreamingFlusher: failed to finalize executionId=${executionId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** Best-effort drain of every pending buffer. Called from `runtime.shutdown()`. */
  async flushAll(): Promise<void> {
    const ids = [...this.buffers.keys()];
    // Flush all buffers, then await any chained writes for each so shutdown
    // doesn't return while a streaming write is still racing.
    await Promise.all(ids.map((id) => this.flush(id)));
    const pendings = [...this.inflight.values()];
    await Promise.allSettled(pendings);
  }
}

/** Detect AbortError from both `DOMException` (browser / Node fetch path)
 *  and a plain `Error` with `name === 'AbortError'` (signal.throwIfAborted,
 *  user-thrown abort). A strict instanceof check misses cancellations
 *  thrown by other code paths. */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/** Preserve caller-facing errors while projecting context-associated rich
 * failures safely to this execution's observer and persistence surfaces. */
function executionErrorProjection(
  ctx: WorkflowContext | undefined,
  error: unknown,
): {
  message: string;
  name?: string;
} {
  const safe = ctx?._observerErrorProjection(error);
  return safe ?? { message: error instanceof Error ? error.message : String(error) };
}

/** Bounded push to `execInfo.events`. Skips high-volume stream-only
 *  variants (token, partial_object — never persisted).
 *
 *  Semantics: `cap` is the MAX array length. When pushing would cross
 *  the cap, the cap-th slot is REPLACED with a sentinel `log` event
 *  describing the truncation. Subsequent events are silently dropped
 *  (the sentinel persists). The trace channel and WS broadcast still
 *  see every event — only the in-memory array is bounded.
 *
 *  Trade-off: replacing rather than appending preserves the documented
 *  "events.length ≤ cap" contract at the cost of dropping the cap-th
 *  regular event. The sentinel itself encodes the cap and reason so
 *  consumers know exactly what was lost. */
function pushEventBounded(execInfo: ExecutionInfo, event: AxlEvent, cap: number): void {
  if (STREAMING_EXCLUDED_TYPES.has(event.type)) return;
  if (cap === Infinity || execInfo.events.length < cap) {
    execInfo.events.push(event);
    return;
  }
  // Length === cap. If the last entry is already the sentinel, this is
  // a silent drop. Otherwise replace the last entry with the sentinel
  // so consumers find a clear truncation marker at array tail.
  const last = execInfo.events[execInfo.events.length - 1];
  const alreadyTruncated =
    last?.type === 'log' &&
    typeof last.data === 'object' &&
    last.data !== null &&
    (last.data as { event?: string }).event === 'events_truncated';
  if (!alreadyTruncated) {
    if (execInfo.observation?.complete !== false) {
      execInfo.observation = {
        complete: false,
        reason: 'persistence_truncated',
        maxEvents: cap,
      };
    }
    if (event.type === 'workflow_end') {
      event.data.observation = execInfo.observation;
    }
    execInfo.events[execInfo.events.length - 1] = {
      schemaVersion: 2,
      type: 'log',
      executionId: event.executionId,
      step: event.step,
      timestamp: Date.now(),
      data: {
        event: 'events_truncated',
        cap,
        message:
          `ExecutionInfo.events truncated at ${cap} entries. ` +
          `Subsequent events are still delivered to runtime.on('trace') ` +
          `and the WS broadcast — only the in-memory array is bounded. ` +
          `Raise via config.state.maxEventsPerExecution.`,
      },
    };
  }
}

/** Drop entries from a metadata bag whose values aren't `structuredClone`-
 *  able. Used as a fallback when `persistExecution` is about to snapshot
 *  an ExecutionInfo whose metadata `liftPersistedMetadata` had to shallow-
 *  copy (because the original contained a function or other non-cloneable
 *  value). The persisted shape stays JSON-clean — no functions reach the
 *  store, where they'd JSON.stringify to `undefined` and silently corrupt
 *  the row. Caller-visible bag is untouched. */
function sanitizeMetadataForPersist(metadata: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    try {
      cleaned[k] = structuredClone(v);
    } catch {
      // Non-cloneable; drop silently. Future enhancement: emit a one-shot
      // console.warn listing the dropped keys so users aren't surprised.
    }
  }
  return cleaned;
}

/** Bound an array of recovered streaming events to the configured per-
 *  execution cap. When truncation is needed, replaces the cap-th slot with
 *  a `log` sentinel describing the truncation (mirrors `pushEventBounded`).
 *  Idempotent: a buffer that already ends in the sentinel is left alone. */
function boundRecoveredEvents(events: HistoricalAxlEvent[], cap: number): HistoricalAxlEvent[] {
  if (cap === Infinity || events.length <= cap) return events;
  const truncated = events.slice(0, cap);
  const last = truncated[truncated.length - 1];
  const alreadyTruncated =
    last?.type === 'log' &&
    typeof last.data === 'object' &&
    last.data !== null &&
    (last.data as { event?: string }).event === 'events_truncated';
  if (!alreadyTruncated) {
    const version = getEventSchemaVersion(events[0] ?? {});
    truncated[truncated.length - 1] = {
      ...(version === 2 ? { schemaVersion: 2 as const } : {}),
      type: 'log',
      executionId: events[0]?.executionId ?? '',
      step: last?.step ?? 0,
      timestamp: Date.now(),
      data: {
        event: 'events_truncated',
        cap,
        message:
          `Recovered ExecutionInfo.events truncated at ${cap} entries. ` +
          `Original streaming buffer had ${events.length} events. ` +
          `Raise via config.state.maxEventsPerExecution.`,
      },
    } as HistoricalAxlEvent;
  }
  return truncated;
}

export type ExecuteOptions = {
  metadata?: Record<string, unknown>;
  /** Handler for tool approval requests. When provided, tools with `requireApproval` resolve
   *  via this handler instead of suspending the execution and registering a pending decision.
   *  Useful for in-process testing and ad-hoc invocations where you don't want to poll
   *  `runtime.getPendingDecisions()` and call `runtime.resolveDecision()`. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => Promise<HumanDecision>;
  /** External AbortSignal. When fired, aborts the workflow exactly as
   *  `runtime.abort(executionId)` would. Lets callers use the standard
   *  JS cancellation pattern (e.g., AbortController from a UI's "stop"
   *  button) without having to track the execution id. */
  signal?: AbortSignal;
  /** Configuration for the workflow context's `ctx.events` bus and the
   *  `AxlStream` returned by `runtime.stream()`. Both consume the same
   *  `EventStreamOptions` (queue cap + overflow policy). When omitted,
   *  defaults are `maxQueued: 10_000` and `onOverflow:
   *  'drop-oldest-non-terminal'`. */
  events?: EventStreamOptions;
  /** Maximum terminal wait for abort-ignoring race/quorum branches. Once
   *  exceeded, finalization proceeds with observation.complete=false. */
  branchDrainTimeoutMs?: number;
};

/**
 * Shape of events forwarded to an eval `onProgress` callback. Mirrors
 * `@axlsdk/eval`'s `EvalProgressEvent` so runtime consumers can type their
 * callbacks without importing the optional peer dep.
 */
export type EvalProgressEventShape =
  | { type: 'item_done'; itemIndex: number; totalItems: number }
  | { type: 'run_done'; totalItems: number; failures: number };

/**
 * Structural shape of `@axlsdk/eval`'s `EvalConfig` as seen by the runtime.
 * `axl` is a peer of `eval` (eval depends on axl, not the reverse), so the core
 * can't import the real `EvalConfig` type — it forwards `config` to `runEval`
 * at runtime regardless. This single declaration is the ONE place to keep in
 * sync with `EvalConfig`'s forwarded fields, so `eval()` and `runRegisteredEval()`
 * don't drift apart (they previously carried two hand-copied inline shapes).
 * `dataset`/`scorers` stay `unknown[]`/`unknown` because their real types live in
 * `@axlsdk/eval`; only the primitive knobs are structurally typed here.
 */
export type RuntimeEvalConfigShape = {
  workflow: string;
  dataset: unknown;
  scorers: unknown[];
  concurrency?: number;
  scorerConcurrency?: number;
  budget?: string;
  failOnScorerErrorRate?: number;
  /** Mirrors `EvalConfig.failOnItemErrorRate` (default `0.05`; `1` disables the gate). */
  failOnItemErrorRate?: number;
  metadata?: Record<string, unknown>;
};

export type CreateContextOptions = {
  metadata?: Record<string, unknown>;
  /** Cost budget for the context (e.g., '$0.50'). Enforced via finish_and_stop policy. */
  budget?: string;
  /** Abort signal for cancellation/timeouts. */
  signal?: AbortSignal;
  /** Prior conversation history for multi-turn eval testing. */
  sessionHistory?: ChatMessage[];
  /** Handler for tool approval requests. Called when an agent invokes a tool with requireApproval. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => Promise<HumanDecision>;
  /** Configuration for the lazy `ctx.events` bus on the returned context.
   *  Defaults: `maxQueued: 10_000`, `onOverflow:
   *  'drop-oldest-non-terminal'`. */
  events?: EventStreamOptions;
};

const REMOVED_OBSERVATION_CALLBACKS = ['onToken', 'onToolCall', 'onAgentStart'] as const;

function assertNoRemovedObservationCallbacks(options: unknown): void {
  if (options === null || typeof options !== 'object') return;
  const removed = REMOVED_OBSERVATION_CALLBACKS.filter((key) => Object.hasOwn(options, key));
  if (removed.length === 0) return;

  throw new AxlError(
    'INVALID_CONFIG',
    `runtime.createContext() no longer accepts ${removed.join(', ')}. ` +
      'Observe ctx.events or use runtime.stream() instead. ' +
      'See docs/migration/stream-first-observation.md.',
  );
}

/** Cost scope for tracking cost across async boundaries via AsyncLocalStorage. */
type CostScope = {
  totalCost: number;
  trackedIds: Set<string>;
  parent?: CostScope;
};

const costScopeStorage = new AsyncLocalStorage<CostScope>();

/** Wire `external` into `internal` so an abort on either fires the
 *  internal controller. Used by `execute` and `stream` so callers can
 *  use a standard `AbortController` instead of having to track
 *  `executionId` for `runtime.abort()`. No-op when `external` is
 *  undefined; immediate-aborts when `external` is already aborted.
 *
 *  Returns a cleanup function the caller MUST invoke when the
 *  execution completes (success or failure). Without cleanup, a
 *  long-lived external signal (e.g., a process-wide shutdown signal,
 *  a request-scoped signal that completes for each request) would
 *  accumulate one listener per `runtime.execute()` call. After ~10
 *  calls Node prints `MaxListenersExceededWarning`; under sustained
 *  load it's a real memory leak. `{ once: true }` only auto-removes
 *  the listener if the signal aborts — the success path leaves it
 *  attached, which the cleanup fn fixes. */
function forwardAbortSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    internal.abort(external.reason);
    return () => {};
  }
  const onAbort = () => internal.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  if (external.aborted) onAbort();
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * Event-derived execution metadata returned by {@link AxlRuntime.trackExecution}
 * and {@link AxlRuntime.trackOutcome}.
 *
 * Derived from trace events, so it follows trace configuration — unlike
 * `Accounting`, which is independent of it.
 */
export type TrackExecutionMetadata = {
  /** Unique effective model URIs observed, in first-seen order. */
  models: string[];
  modelCallCounts?: Record<string, number>;
  /**
   * Agent token totals only — embedder tokens from semantic memory are a
   * different category and are excluded. Read `Accounting.usage` for the
   * folded, category-separated totals.
   */
  tokens: { input: number; output: number; reasoning: number };
  agentCalls: number;
  /**
   * Unique workflow names observed during execution, ordered by first
   * appearance (outermost first for nested calls). Captured automatically
   * from `workflow_start` trace events — callers don't need to declare
   * anything. Parallel mechanism to `models`.
   */
  workflows: string[];
  /** Call counts per workflow, if workflows.length > 0. */
  workflowCallCounts?: Record<string, number>;
};

/**
 * Per-model sums of `agent_call_end.timing`, keyed by the same effective
 * model URI as `TrackExecutionMetadata.modelCallCounts`. Present only when at
 * least one tracked call reported timing, so absence means "nothing was
 * instrumented" rather than "everything took zero ms".
 *
 * `calls` counts the SUCCESSFUL timed calls only — it can be lower than the
 * same model's `modelCallCounts` entry when a provider omits `timing` or a
 * call failed. Divide a sum by `calls`, never by `modelCallCounts`.
 *
 * Failed calls are excluded even though they now report timing: a non-2xx
 * response is a measured round trip, but a rollup blending answers with
 * failures describes neither, and a fast 429 would improve a model's
 * apparent latency. The failures stay on the events themselves.
 *
 * `firstTokenMs` is streaming-only and is summed across the calls that
 * reported it; it is omitted entirely when no call did, so a non-streaming
 * model never reports a misleading `0`. Its denominator is `firstTokenCalls`,
 * NOT `calls` — the two travel together and are present or absent together,
 * so a mixed streaming/non-streaming model still yields an exact mean.
 *
 * Sums are per-call totals, so `wireMs` across concurrent calls can exceed
 * the wall clock of the tracked function — that is expected under fan-out and
 * is why nothing in the core sums timing at the ask level.
 */
export type ModelTimingRollup = Record<
  string,
  {
    calls: number;
    queuedMs: number;
    retryMs: number;
    wireMs: number;
    firstTokenMs?: number;
    /** Timed calls that reported a `firstTokenMs` — the denominator for it. */
    firstTokenCalls?: number;
    /**
     * The per-call blocks the sums were built from, in settlement order.
     * `length === calls`. Present only under `captureTimingSamples`, because
     * retaining it is O(calls) in memory and the sums alone are O(models) — a
     * caller that needs a real DISTRIBUTION (percentiles, min/max) cannot
     * recover one from sums, and everyone else should not pay for it.
     */
    samples?: CallTiming[];
  }
>;

/** Options for {@link AxlRuntime.trackOutcome}. */
export type TrackOutcomeOptions = {
  /**
   * How this scope's operations are classified in `Accounting.breakdown`.
   * Defaults to the enclosing scope's purpose, else `'generation'`.
   */
  purpose?: OperationPurpose;
  /** Stop admitting new paid operations once known spend reaches its limit. */
  admission?: AdmissionController;
  /** Collect the raw `AxlEvent[]` observed during the call. */
  captureTraces?: boolean;
  /** Retain the per-call `CallTiming` blocks behind the `modelTiming` sums. */
  captureTimingSamples?: boolean;
  /**
   * Opt in to bounded, redaction-aware capture of the provider-neutral REQUESTS
   * this scope submits, written into `sink` as JSONL.
   *
   * Diagnostics only: capture can be truncated, fail outright, or be turned off
   * entirely and `accounting` is byte-identical either way. The sink is never
   * awaited by a provider call. Nested scopes inherit the enclosing channel, so
   * declare it once at the outermost scope of a run.
   *
   * The CALLER owns the channel because the caller is the one that has to
   * `close()` it and read back its operation ledger after the run.
   */
  capture?: RequestCaptureChannel;
  /**
   * Stamp consumer-side identity onto every record captured inside this scope
   * (an eval's `caseIndex`, a judge's `scorer` name). Merged over the enclosing
   * scope's correlation, so a scorer scope keeps its item's case index.
   */
  captureCorrelation?: CaptureCorrelation;
};

/** The result of {@link AxlRuntime.trackOutcome} — never a rejection. */
export type TrackedOutcome<T> = (
  | { status: 'fulfilled'; value: T }
  /** The ORIGINAL thrown value: primitives and frozen objects are untouched. */
  | { status: 'rejected'; error: unknown }
) & {
  /** Authoritative spend. Independent of trace level, capture and redaction. */
  accounting: Accounting;
  metadata: TrackExecutionMetadata;
  modelTiming?: ModelTimingRollup;
  traces?: AxlEvent[];
};

/** The result of {@link AxlRuntime.trackExecution}. */
export type TrackExecutionResult<T> = {
  result: T;
  /** Compatibility view of `accounting.knownCost`. */
  cost: number;
  /** Compatibility view of `accounting.completeness !== 'complete'`. When true,
   *  `cost` is a LOWER BOUND. */
  unpriced: boolean;
  /** The authoritative record `cost` and `unpriced` are derived from. */
  accounting: Accounting;
  modelTiming?: ModelTimingRollup;
  traces?: AxlEvent[];
  metadata: TrackExecutionMetadata;
};

/**
 * Attach captured traces to a thrown value so `trackExecution` callers can
 * recover the diagnostic trail on failure. Non-enumerable so it does not
 * pollute JSON serialization or stack traces.
 *
 * Best effort by design: a frozen or sealed error must come back to the caller
 * with its identity intact, so a failed attachment is swallowed rather than
 * replacing the user's error with a `TypeError` about property definition.
 */
function attachCapturedTraces(error: unknown, traces: AxlEvent[]): void {
  if (typeof error !== 'object' || error === null) return;
  try {
    Object.defineProperty(error, 'axlCapturedTraces', {
      value: traces,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // Frozen/sealed thrown value — the error identity matters more.
  }
}

/**
 * The main entry point for executing Axl workflows.
 * Manages workflow registration, provider resolution, state storage, tracing, MCP servers,
 * and human-in-the-loop decision handling. Supports both synchronous (`execute`) and
 * streaming (`stream`) execution modes, as well as multi-turn sessions.
 */
export class AxlRuntime extends EventEmitter {
  private config: AxlConfig;
  private workflows = new Map<string, Workflow>();
  private tools = new Map<string, Tool>();
  private agents = new Map<string, Agent>();
  private providerRegistry: ProviderRegistry;
  /** Raw adapter → its scoped facade. Keyed weakly so a registry that drops an
   *  adapter does not pin it here. */
  private scopedProviders = new WeakMap<Provider, Provider>();
  private transcriptionProviderRegistry: TranscriptionProviderRegistry;
  private stateStore: StateStore;
  private executions = new Map<string, ExecutionInfo>();
  private pendingDecisionResolvers = new Map<string, PendingDecisionResolver>();
  private abortControllers = new Map<string, AbortController>();
  private registeredEvals = new Map<
    string,
    { config: unknown; executeWorkflow?: EvalExecuteWorkflow }
  >();
  private mcpManager?: McpManager;
  private memoryManager?: MemoryManager;
  private spanManager: SpanManager = new NoopSpanManager();
  private historicalExecutions = new Map<string, HistoricalExecutionInfo>();
  private historicalExecutionsLoadPromise: Promise<void> | null = null;
  /** Per-session in-process serialization. Each entry is a chain of pending
   *  work for that session id — `Session.send` / `Session.stream` await the
   *  prior entry before reading history, so concurrent calls produce a
   *  sequenced conversation log instead of last-writer-wins corruption.
   *  Cross-process locking is NOT provided; use distinct session ids when
   *  multiple processes share a store. */
  private sessionLocks = new Map<string, Promise<void>>();
  private evalHistory: EvalHistoryEntry[] = [];
  private evalHistoryLoadPromise: Promise<void> | null = null;
  /** Resolved cap on `ExecutionInfo.events` per execution. Cached on
   *  the instance so per-event onTrace handlers don't reach into
   *  `this.config.state` on every emission. */
  private readonly maxEventsPerExecution: number;
  /** Tracks executionIds for which we've already warned about a malformed
   *  `events` field — keeps the log to one line per row instead of one per
   *  rebuild tick. */
  private warnedMalformedExecutions = new Set<string>();
  /** Streaming-mode flusher. `undefined` when persist === 'terminal'
   *  (back-compat default — no buffering overhead, no batching timer). */
  private streamingFlusher?: StreamingFlusher;
  /** Execution IDs that are eligible for streaming-buffer durability —
   *  populated by `execute()` / `stream()`. `createContext()` flows are
   *  deliberately NOT added: ad-hoc contexts (tool tests, Studio playground,
   *  evals) have no terminal `persistExecution` path that would finalize the
   *  streaming buffer, so allowing them to write would leave phantom orphan
   *  buffers that `recoverIncompleteStreams()` later mis-recovers as failed
   *  executions. Membership is removed in `persistExecution` once the
   *  canonical save + finalize chain has been scheduled. */
  private streamableExecutionIds = new Set<string>();
  /** Execution IDs deleted by `runtime.deleteExecution()` while still in
   *  flight. `persistExecution` skips its save + cache write when the
   *  executionId is in this set — preventing a workflow that completes after
   *  a delete from resurrecting the (intentionally-removed) row. Entries are
   *  removed once the would-be persist has been short-circuited. */
  private pendingDeletedExecutions = new Set<string>();
  /** In-flight `persistExecution` chains (save → finalize). `shutdown()`
   *  awaits these before closing the StateStore so a workflow whose abort
   *  triggers a persist-during-shutdown isn't racing a closed connection.
   *  The Set is mutated by the chain's own `.finally` so entries clear as
   *  soon as the work settles. */
  private persistInflight = new Set<Promise<void>>();
  /** Resolved diagnostic artifact backend, when `diagnostics.artifacts` is set. */
  private artifactStore?: DiagnosticArtifactStore;
  private artifactLeaseMs = DEFAULT_ARTIFACT_LEASE_MS;
  private artifactMaxHoldMs = DEFAULT_ARTIFACT_MAX_HOLD_MS;
  private artifactSweepTimer?: ReturnType<typeof setInterval>;
  /**
   * Eval history ids this process has established are gone.
   *
   * Two jobs. It makes a delete started here beat a correction already in
   * flight, which no store-side condition can do while the delete has not
   * landed yet. And it keeps the lazy first load from merging a row back in
   * from a snapshot taken before the eviction. Ids are minted per result and
   * never reused, so an entry can only ever be right.
   *
   * Bounded like the artifact store's deleted-id window, and for the same
   * reason: a long-lived server with TTL churn would otherwise grow it for the
   * life of the process. Both jobs are windows measured in the length of one
   * in-flight write or one lazy first load, so the oldest ids are the ones with
   * nothing left to protect. Past the window the row is simply re-read from the
   * store, which by then is the authority anyway.
   */
  private readonly deletedEvalIds = new Set<string>();
  /** Lease-renewal timers for artifacts currently being written, by id. */
  private readonly artifactRenewals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config?: AxlConfig) {
    super();
    this.config = resolveConfig(config ?? {});
    this.providerRegistry = new ProviderRegistry();
    this.transcriptionProviderRegistry = new TranscriptionProviderRegistry();
    this.stateStore = this.createStateStore();
    // Resolve + validate the events cap once at construction. Reject
    // 0 / negatives / fractions / NaN early; allow Infinity for the
    // legacy "unbounded" opt-out.
    const requested = this.config.state?.maxEventsPerExecution;
    if (requested === undefined) {
      this.maxEventsPerExecution = DEFAULT_MAX_EVENTS_PER_EXECUTION;
    } else if (requested === Infinity) {
      this.maxEventsPerExecution = Infinity;
    } else if (
      typeof requested !== 'number' ||
      !Number.isFinite(requested) ||
      !Number.isInteger(requested) ||
      requested < 1
    ) {
      throw new RangeError(
        `config.state.maxEventsPerExecution must be a positive integer or Infinity; got ${requested}`,
      );
    } else {
      this.maxEventsPerExecution = requested;
    }
    if (this.config.memory) {
      this.memoryManager = new MemoryManager({
        vectorStore: this.config.memory.vectorStore,
        embedder: this.config.memory.embedder,
      });
    }
    // Stand up the streaming flusher iff `state.persist === 'streaming'`
    // AND the configured store implements the streaming methods. If the
    // store doesn't support streaming (e.g. a custom StateStore, or SQLite
    // which doesn't implement these methods), we leave the flusher
    // undefined and emit a one-shot warning so users don't think they're
    // getting durability they're not.
    if (this.config.state?.persist === 'streaming') {
      if (this.stateStore.appendStreamingEvents) {
        this.streamingFlusher = new StreamingFlusher(
          this.stateStore,
          this.config.state.streamingBatchSize ?? DEFAULT_STREAMING_BATCH_SIZE,
          this.config.state.streamingBatchInterval ?? DEFAULT_STREAMING_BATCH_INTERVAL,
        );
      } else {
        console.warn(
          `[axl] config.state.persist === 'streaming' but the configured StateStore ` +
            `does not implement appendStreamingEvents. Streaming durability is disabled. ` +
            `Use RedisStore for crash-survival, or implement the optional streaming ` +
            `methods on your custom StateStore.`,
        );
      }
    }
    this.setUpDiagnosticArtifacts();
  }

  // ── Diagnostic artifacts (opt-in request capture) ────────────────────

  /**
   * Resolve the artifact backend and arm reclamation.
   *
   * Two configuration errors are raised HERE rather than at capture time,
   * because both mean "this deployment can never host managed capture" and the
   * alternative is discovering it after an eval has already spent money:
   * a `diagnostics.artifacts` block with neither `store` nor `root`, and a
   * custom `StateStore` that cannot report eval retention.
   */
  private setUpDiagnosticArtifacts(): void {
    const artifacts = this.config.diagnostics?.artifacts;
    if (!artifacts) return;
    if (artifacts.store) {
      this.artifactStore = artifacts.store;
    } else if (typeof artifacts.root === 'string' && artifacts.root.trim() !== '') {
      this.artifactStore = new FileDiagnosticArtifactStore({ root: artifacts.root });
    } else {
      throw new AxlError(
        'DIAGNOSTICS_UNAVAILABLE',
        'config.diagnostics.artifacts requires either `root` (built-in filesystem store) ' +
          'or `store` (a host-supplied DiagnosticArtifactStore). Axl will not write captured ' +
          'requests to a process temp folder.',
      );
    }
    if (typeof this.stateStore.getEvalRetention !== 'function') {
      throw new AxlError(
        'DIAGNOSTICS_UNAVAILABLE',
        'config.diagnostics.artifacts requires a StateStore implementing getEvalRetention(id) ' +
          'so artifact lifetime can follow the eval history row that owns it. The built-in ' +
          'memory, SQLite and Redis stores implement it; add it to your custom store.',
      );
    }
    this.artifactLeaseMs =
      typeof artifacts.leaseMs === 'number' && artifacts.leaseMs > 0
        ? artifacts.leaseMs
        : DEFAULT_ARTIFACT_LEASE_MS;
    this.artifactMaxHoldMs =
      typeof artifacts.maxHoldMs === 'number' && artifacts.maxHoldMs > 0
        ? artifacts.maxHoldMs
        : DEFAULT_ARTIFACT_MAX_HOLD_MS;
    const sweepMs =
      typeof artifacts.sweepIntervalMs === 'number' && artifacts.sweepIntervalMs > 0
        ? artifacts.sweepIntervalMs
        : DEFAULT_ARTIFACT_SWEEP_MS;
    // Startup reconciliation: a process that was down while a Redis TTL expired
    // (or that died mid-run) has orphaned bytes on disk right now. Fire-and-
    // forget so construction stays synchronous; failures are diagnostics-only.
    void this.reconcileDiagnosticArtifacts().catch(() => undefined);
    this.artifactSweepTimer = setInterval(() => {
      void this.reconcileDiagnosticArtifacts().catch(() => undefined);
    }, sweepMs);
    // Never hold the event loop open for a diagnostics sweeper.
    this.artifactSweepTimer.unref?.();
  }

  /** The configured artifact backend, or `undefined` when capture is off. */
  getDiagnosticArtifactStore(): DiagnosticArtifactStore | undefined {
    return this.artifactStore;
  }

  private requireArtifactStore(): DiagnosticArtifactStore {
    if (!this.artifactStore) {
      throw new AxlError(
        'DIAGNOSTICS_UNAVAILABLE',
        'Request capture was requested but no diagnostic artifact store is configured. ' +
          'Set config.diagnostics.artifacts = { root: "<dir>" } (or supply your own `store`).',
      );
    }
    return this.artifactStore;
  }

  /**
   * Reserve an artifact for `owner` and hand back a sink to write records into.
   *
   * Throws `AxlError('DIAGNOSTICS_UNAVAILABLE')` BEFORE any work when capture is
   * not configured, which is why `runEval` calls it ahead of loading the
   * dataset. The returned sink renews the staging lease as it writes, so a long
   * run is never swept out from under itself, while a run that dies leaves a
   * lease that expires and is reclaimed.
   */
  async stageDiagnosticArtifact(owner: ArtifactOwner): Promise<{
    artifactId: string;
    sink: RequestCaptureSink;
  }> {
    const staged = await this.requireArtifactStore().stage(owner, {
      leaseMs: this.artifactLeaseMs,
    });
    return this.holdStagedArtifact(staged);
  }

  /**
   * Hold a staged artifact's lease for as long as its writer lives, and hand
   * back the sink that writer appends through.
   *
   * The lease belongs to the WRITER's lifetime, not to its write rate. Renewing
   * from inside `append` looks equivalent and is not: a run that exhausts
   * `maxRunBytes` at minute two stops appending forever, and a run waiting on a
   * tool or a human approval may not call a provider for longer than a lease.
   * Either way the sweeper would delete a live run's evidence, and the run
   * would then fail to finalize the artifact it had been filling.
   */
  private holdStagedArtifact(staged: StagedArtifact): {
    artifactId: string;
    sink: RequestCaptureSink;
  } {
    const store = this.requireArtifactStore();
    // A caller that neither finalizes nor rolls back would otherwise pin this
    // artifact FOREVER: the sweeper only reclaims a lease that expired, so a
    // renewal nobody stops removes the last self-healing path. The hold is
    // therefore bounded — past `maxHoldMs` the runtime lets go, the lease runs
    // out, and the artifact is reclaimed like any abandoned writer's. Callers
    // still stop their own timers; this is the floor under a caller bug.
    const heldUntil = Date.now() + this.artifactMaxHoldMs;
    const timer = setInterval(
      () => {
        if (Date.now() >= heldUntil) {
          this.stopArtifactRenewal(staged.artifactId);
          return;
        }
        void staged.renewLease().catch(() => undefined);
      },
      Math.max(1, Math.floor(this.artifactLeaseMs / 2)),
    );
    timer.unref?.();
    this.artifactRenewals.set(staged.artifactId, timer);
    return {
      artifactId: staged.artifactId,
      sink: {
        append: (line: string) => store.append(staged.artifactId, line),
      },
    };
  }

  /** Stop renewing a lease once the writer is done with the artifact. */
  private stopArtifactRenewal(artifactId: string): void {
    const timer = this.artifactRenewals.get(artifactId);
    if (!timer) return;
    clearInterval(timer);
    this.artifactRenewals.delete(artifactId);
  }

  /** Seal a staged artifact's manifest. Called before the history row is saved. */
  async finalizeDiagnosticArtifact(
    artifactId: string,
    status: ArtifactStatus,
    reason?: string,
    redaction?: 'applied' | 'none',
  ): Promise<ArtifactManifest> {
    // Stop renewing FIRST: a renewal landing after the finalized manifest is
    // exactly the write the store's serializer exists to order, and there is
    // nothing left to keep alive.
    this.stopArtifactRenewal(artifactId);
    return this.requireArtifactStore().finalize(artifactId, status, reason, redaction);
  }

  /** Discard a staged artifact whose owner will never be written. */
  async rollbackDiagnosticArtifact(artifactId: string): Promise<void> {
    this.stopArtifactRenewal(artifactId);
    await this.requireArtifactStore().rollback(artifactId);
  }

  /**
   * Copy a source run's artifact into a new owner (rescore provenance).
   *
   * Bounded by `maxBytes`; a partial copy reports `truncated` so the caller can
   * finalize the new manifest honestly. Returns `undefined` when the source is
   * gone — a rescore of a run whose artifact was deleted still produces numbers,
   * it just reports its diagnostics as `unavailable`.
   *
   * The copy comes back STAGED and lease-held, with a sink: the new owner
   * carries the source records forward AND keeps writing its own calls into the
   * same artifact, which is what makes one rescore result hold both halves of
   * its evidence.
   */
  async copyDiagnosticArtifact(
    sourceId: string,
    owner: ArtifactOwner,
    opts: { maxBytes: number },
  ): Promise<
    | {
        artifactId: string;
        truncated: boolean;
        bytes: number;
        /** What the SOURCE manifest said about the copied bytes. Never inferred. */
        redaction: 'applied' | 'none';
        sink: RequestCaptureSink;
      }
    | undefined
  > {
    const copied = await this.requireArtifactStore().copy(sourceId, owner, {
      maxBytes: opts.maxBytes,
      leaseMs: this.artifactLeaseMs,
    });
    if (!copied) return undefined;
    return {
      ...this.holdStagedArtifact(copied),
      truncated: copied.truncated,
      bytes: copied.bytes,
      redaction: copied.redaction,
    };
  }

  /**
   * Read a committed artifact's records, or `undefined`.
   *
   * Two logical checks stand between a caller and the bytes, because the bytes
   * outlive the store that governs them: the owning history row must still
   * exist, and the mirrored `expiresAt` must not have passed. A Redis row that
   * aged out while this process was offline therefore reads as unavailable the
   * moment it is asked for, not whenever the sweeper next runs.
   */
  async openDiagnosticArtifact(artifactId: string): Promise<OpenedArtifact | undefined> {
    if (!this.artifactStore) return undefined;
    const opened = await this.artifactStore.open(artifactId);
    if (!opened) return undefined;
    const { manifest } = opened;
    // §12.1: only a committed artifact is readable here. A staged one has no
    // owner row yet (or never will), and a delete_pending one is on its way
    // out. The CLI's standalone bundle is deliberately not on this path — it
    // reads through `getDiagnosticArtifactStore()` because it has no history
    // row to resolve through.
    if (manifest.state !== 'committed') return undefined;
    if (manifest.expiresAt !== undefined && manifest.expiresAt <= Date.now()) return undefined;
    const retention = await this.stateStore.getEvalRetention?.(manifest.owner.id);
    if (retention && !retention.exists) return undefined;
    return opened;
  }

  /**
   * Reclaim artifacts nothing can legitimately read any more.
   *
   * Removed: everything marked `delete_pending` (a delete that did not finish),
   * every `committed` artifact whose owner row is gone or whose expiry has
   * passed, and every `staged` artifact whose lease ran out. A staged artifact
   * with a LIVE lease is never touched — that is an active writer, and sweeping
   * it would race a run that is still producing evidence.
   */
  async reconcileDiagnosticArtifacts(): Promise<{ removed: string[] }> {
    const store = this.artifactStore;
    if (!store) return { removed: [] };
    const now = Date.now();
    const removed: string[] = [];
    for (const manifest of await store.list()) {
      let cause: string | undefined;
      if (manifest.state === 'delete_pending') {
        cause = 'a delete that did not finish was completed by the sweep';
      } else if (manifest.state === 'staged') {
        if (manifest.leaseUntil === undefined || manifest.leaseUntil <= now) {
          cause = "its writer's lease expired, so the sweep reclaimed it";
        }
      } else {
        if (manifest.expiresAt !== undefined && manifest.expiresAt <= now) {
          cause = 'it reached its retention expiry and was reclaimed';
        } else {
          const retention = await this.stateStore.getEvalRetention?.(manifest.owner.id);
          if (retention && !retention.exists) {
            cause = 'the history row that owned it is gone, so it was reclaimed';
          }
        }
      }
      if (cause === undefined) continue;
      try {
        await store.delete(manifest.artifactId);
        removed.push(manifest.artifactId);
      } catch {
        // Leave it for the next sweep rather than aborting the whole pass —
        // one undeletable artifact must not strand every other orphan.
        continue;
      }
      // The bytes are gone; the row that points at them must say so, or every
      // reader is left depending on a liveness check to discover it — and the
      // ones that cannot make one (an export, a CLI listing, a client cache
      // rendered from a stored result) publish a result promising evidence
      // nothing can serve. A staged or delete_pending artifact usually has no
      // committed owner row, but if one exists it gets the same treatment: the
      // lookup is by owner id and does not care which state it was reclaimed
      // from.
      await this.downgradeReclaimedOwner(manifest, cause);
    }
    return { removed };
  }

  /**
   * Rewrite the history row that owned an artifact the sweep has just removed.
   *
   * Best effort by design: reclaiming the bytes is the operation that had to
   * succeed, and a state store that cannot take the correction must not turn a
   * routine sweep into a throwing one. The next `saveEvalResult` or artifact
   * read corrects the row anyway, because both already downgrade a dangling id.
   */
  private async downgradeReclaimedOwner(manifest: ArtifactManifest, cause: string): Promise<void> {
    if (manifest.owner.kind !== 'eval') return;
    try {
      const entry = await this.getEvalResult(manifest.owner.id);
      // Only the row that actually names THIS artifact: a degraded rescore
      // carries its source's id in provenance, and rewriting a row over an
      // artifact it does not own is the cross-result corruption §12.1 forbids.
      if (!entry || this.artifactIdOf(entry.data) !== manifest.artifactId) return;
      this.downgradeDiagnostics(
        entry,
        `the captured-request artifact for this result is gone: ${cause}`,
      );
      await this.persistCorrectedRow(entry);
    } catch {
      // See the docstring: the bytes are already gone either way.
    }
  }

  /**
   * Write back a history row this process corrected in memory — but ONLY while
   * the store still holds it.
   *
   * The history cache is process-global, loaded once and evicted only by
   * `deleteEvalResult`. It therefore outlives whatever the STORE decided: a
   * Redis TTL that elapsed, a delete by another process, a
   * right-to-be-forgotten request. A blind `saveEvalResult` of a cached row
   * resurrects all of it — item inputs, outputs and scores — and on Redis
   * re-SETs it with a fresh full TTL window, silently extending the retention
   * the operator configured. Correcting a row must never be able to un-delete
   * one, so the store is asked first and the stale cache entry is dropped when
   * the answer is no.
   *
   * A store with no retention view cannot answer, and a blind write is exactly
   * what this exists to prevent, so nothing is written: the cache is corrected
   * and the store keeps what it decided. In practice the question does not
   * arise, because configuring artifacts at all requires `getEvalRetention`.
   */
  private async persistCorrectedRow(entry: EvalHistoryEntry): Promise<boolean> {
    // A delete this process already started always wins. It may still be in
    // flight — `deleteEvalResult` awaits the store — and the store cannot
    // refuse a write for a row it has not removed yet.
    if (this.deletedEvalIds.has(entry.id)) {
      this.forgetEvalRow(entry.id);
      return false;
    }
    // Update-only or nothing. A store that cannot promise the write will not
    // CREATE the row cannot be handed a correction at all: checking first and
    // then saving leaves a window a delete or an expiry slips through, and on a
    // store with no expiry the row it recreates never ages back out. The cache
    // is corrected either way, so this process stops publishing a promise of
    // bytes that are gone.
    if (!this.stateStore.updateEvalResult) return false;
    let updated: boolean;
    try {
      updated = await this.stateStore.updateEvalResult(entry);
    } catch (err) {
      // A store that cannot express the write at all is a misconfiguration, and
      // every caller here is best-effort: the raw rejection would vanish into
      // their catches and the operator would never learn that no correction has
      // ever been persisted. Only this one class is absorbed; anything else
      // keeps the existing behaviour and propagates to the caller.
      if (!(err instanceof AxlError) || err.code !== 'REDIS_VERSION_UNSUPPORTED') throw err;
      if (!warnedUpdateUnsupported) {
        warnedUpdateUnsupported = true;
        console.warn(`[axl] ${err.message} Corrections apply to this process's cache only.`);
      }
      return false;
    }
    if (!updated) this.forgetEvalRow(entry.id);
    return updated;
  }

  /**
   * Drop a row from the history cache and refuse to re-add it.
   *
   * The cache is process-global and loaded once, so a row the STORE has
   * dropped — expired, deleted here or elsewhere — would otherwise be served
   * for the life of the process, and an in-flight first load whose snapshot
   * predates the eviction would merge it straight back in.
   */
  private forgetEvalRow(id: string): void {
    this.evalHistory = this.evalHistory.filter((e) => e.id !== id);
    // Re-adding does not move an existing id to the back of a Set's insertion
    // order, but an id re-enters the cache only through a save, which clears
    // its tombstone, so there is nothing to refresh.
    this.deletedEvalIds.add(id);
    while (this.deletedEvalIds.size > DELETED_EVAL_MEMORY) {
      const oldest = this.deletedEvalIds.values().next();
      if (oldest.done) break;
      this.deletedEvalIds.delete(oldest.value);
    }
  }

  /** The artifact id an eval result carries, when it carries one. */
  private artifactIdOf(data: unknown): string | undefined {
    const diagnostics = (data as { diagnostics?: { artifactId?: unknown } } | undefined)
      ?.diagnostics;
    if (typeof diagnostics?.artifactId !== 'string') return undefined;
    return diagnostics.artifactId === '' ? undefined : diagnostics.artifactId;
  }

  /**
   * Rewrite an entry's diagnostics to say plainly that its evidence is gone.
   *
   * Mutates the entry in place on purpose: the caller usually holds the same
   * `EvalResult` object it is about to return to a user, and a result that
   * claims `complete` while storage has nothing is the failure being fixed.
   * The dangling id is cleared too — `''` is the sentinel every lifecycle path
   * already skips.
   */
  private downgradeDiagnostics(entry: EvalHistoryEntry, reason?: string): void {
    const data = entry.data as { diagnostics?: Record<string, unknown> } | undefined;
    if (!data?.diagnostics) return;
    if (data.diagnostics.artifactId === '' && data.diagnostics.status === 'unavailable') return;
    // `records`, `bytes` and `expiresAt` described evidence this rewrite has
    // just declared absent. Spreading them through would leave a result reading
    // `status: 'unavailable', records: 137, bytes: 2100000` — a count of
    // something nobody can read. `unavailableManifest` on the eval side zeroes
    // them for the same reason.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expiresAt, ...rest } = data.diagnostics;
    data.diagnostics = {
      ...rest,
      artifactId: '',
      status: 'unavailable',
      reason: reason ?? 'the captured-request artifact for this result is no longer available',
      records: 0,
      bytes: 0,
    };
  }

  /**
   * The artifact id `ownerId` actually owns, or `undefined`.
   *
   * `diagnostics.artifactId` is data on a result object, and a result can carry
   * an id that belongs to a DIFFERENT run — a rescore that degraded while
   * naming its source, or an imported blob. Committing or deleting on the
   * strength of that field alone lets one entry rewrite or destroy another
   * entry's evidence, so ownership is confirmed against the manifest before
   * any lifecycle write.
   */
  private async ownedArtifactId(
    artifactId: string | undefined,
    ownerId: string,
  ): Promise<string | undefined> {
    if (!artifactId || !this.artifactStore) return undefined;
    try {
      const opened = await this.artifactStore.open(artifactId);
      if (!opened) return undefined;
      return opened.manifest.owner.id === ownerId ? artifactId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `config.trace.redact` is enabled on this runtime. A narrow
   * boolean getter is preferred over exposing the full config because:
   * (a) `Readonly<AxlConfig>` is shallow so the config would be mutable
   * at runtime through sub-objects, subverting any compliance guarantee;
   * (b) observability consumers like Studio only need the boolean, not
   * the whole config tree; (c) if future observability config needs to
   * expand, each new flag gets its own narrow getter.
   *
   * Studio's server-side redaction helpers (executions, memory, sessions,
   * evals, decisions, tools, playground, workflows) all route through
   * this accessor to decide whether to scrub response payloads.
   */
  isRedactEnabled(): boolean {
    return this.config.trace?.redact === true;
  }

  /**
   * Initialize MCP servers configured in the config.
   * Call this before executing workflows that use MCP tools.
   */
  async initializeMcp(): Promise<void> {
    if (this.config.mcp?.servers && this.config.mcp.servers.length > 0) {
      this.mcpManager = new McpManager();
      await this.mcpManager.initialize(this.config.mcp.servers);
    }
  }

  /**
   * Initialize OpenTelemetry telemetry based on config.
   * Call this before executing workflows to enable span creation.
   */
  async initializeTelemetry(): Promise<void> {
    this.spanManager = await createSpanManager(this.config.telemetry);
  }

  /** Get the MCP manager (if initialized). */
  getMcpManager(): McpManager | undefined {
    return this.mcpManager;
  }

  private createStateStore(): StateStore {
    const storeOption = this.config.state?.store ?? 'memory';
    if (typeof storeOption !== 'string') return storeOption;
    switch (storeOption) {
      case 'sqlite':
        return new SQLiteStore(this.config.state?.sqlite?.path ?? './data/axl.db');
      case 'memory':
      default:
        return new MemoryStore();
    }
  }

  /**
   * Run a workflow body inside an ALREADY-CONSTRUCTED `WorkflowContext`
   * with full lifecycle invariants: emit `workflow_start` → run handler
   * → parse output → emit `workflow_end` → delete checkpoints → persist.
   *
   * Shared between `execute()` and `stream()`. Centralizes the
   * "start iff end" pairing invariant and AbortError detection.
   *
   * Side effects on `execInfo`: sets `status` / `completedAt` /
   * `duration` / `result` (or `error`) before emitting `workflow_end`.
   * On throw: emits `workflow_end({status: 'failed', aborted?})` and
   * persists before rethrowing. `abortControllers.delete` and
   * `cleanupAbortForwarder` (if provided) both run in `finally`
   * regardless of outcome.
   *
   * Caller responsibilities:
   * - Allocate `executionId` and register it in `abortControllers` map
   *   BEFORE calling this helper (so early-throw paths still have a
   *   correlation id available for terminal events).
   * - Construct `execInfo` and `ctx` before calling.
   * - Pass `span` if the call site is inside a tracer span — this
   *   helper sets `axl.workflow.cost` / `.duration` attributes on
   *   success.
   * - Pass `cleanupAbortForwarder` (the cleanup fn returned from
   *   `forwardAbortSignal`) so the listener on the user's external
   *   signal is removed when the workflow completes — see the
   *   helper's docstring for the leak this prevents.
   */
  private async runWorkflowBody(args: {
    workflow: AnyWorkflow;
    ctx: WorkflowContext;
    execInfo: ExecutionInfo;
    validated: unknown;
    span?: SpanHandle;
    cleanupAbortForwarder?: () => void;
  }): Promise<unknown> {
    const { workflow, ctx, execInfo, validated, span, cleanupAbortForwarder } = args;
    let observation = execInfo.observation ?? { complete: true as const };
    try {
      // Spec/16 §3.6a: workflow_start is a first-class trace event
      // emitted inside the span context so OTel exporters that correlate
      // events to spans via active-context see it.
      ctx._emitWorkflowStart(validated);
      const raw = await workflow.handler(ctx);
      const drainedObservation = await ctx._drainBranchWork();
      observation =
        drainedObservation.complete === false
          ? drainedObservation
          : (execInfo.observation ?? drainedObservation);
      const result = workflow.outputSchema ? workflow.outputSchema.parse(raw) : raw;

      execInfo.status = 'completed';
      execInfo.completedAt = Date.now();
      execInfo.duration = execInfo.completedAt - execInfo.startedAt;
      execInfo.result = result;
      execInfo.observation = observation;
      ctx._emitWorkflowEnd({
        status: 'completed',
        duration: execInfo.duration,
        result,
        observation,
      });

      // Clean up checkpoints for completed execution
      if (this.stateStore.deleteCheckpoints) {
        await this.stateStore.deleteCheckpoints(execInfo.executionId);
      }

      span?.setAttribute('axl.workflow.cost', execInfo.totalCost);
      span?.setAttribute('axl.workflow.duration', execInfo.duration);

      this.persistExecution(execInfo);
      return result;
    } catch (err) {
      let terminalError = err;
      // A workflow can fail while race/quorum losers are still unwinding.
      // Their terminal events and measurable cost belong before the workflow
      // terminal/persisted snapshot just as they do on the success path.
      try {
        const drainedObservation = await ctx._drainBranchWork();
        observation =
          drainedObservation.complete === false
            ? drainedObservation
            : (execInfo.observation ?? drainedObservation);
      } catch (drainErr) {
        // Strict event overflow is an observability-integrity failure and must
        // replace an ordinary branch/handler error without skipping workflow_end.
        terminalError =
          drainErr instanceof Error ? preserveErrorCause(drainErr, terminalError) : drainErr;
      }
      const aborted = isAbortError(terminalError);
      execInfo.status = 'failed';
      execInfo.completedAt = Date.now();
      execInfo.duration = execInfo.completedAt - execInfo.startedAt;
      execInfo.error = executionErrorProjection(ctx, terminalError).message;
      execInfo.observation = observation;
      ctx._emitWorkflowEnd({
        status: 'failed' as const,
        duration: execInfo.duration,
        error: execInfo.error,
        ...(aborted ? { aborted: true } : {}),
        observation,
      });
      this.persistExecution(execInfo);
      throw terminalError;
    } finally {
      this.abortControllers.delete(execInfo.executionId);
      cleanupAbortForwarder?.();
    }
  }

  /**
   * Persist a completed/failed execution to the state store (fire-and-forget)
   * and move it from the active executions map to the historical cache.
   *
   * Resurrection guard: if `runtime.deleteExecution(id)` was called while
   * this execution was still running, the id will be in
   * `pendingDeletedExecutions`. In that case we skip the save AND the
   * historical-cache write, and finalize the streaming buffer (if any) so
   * the buffer doesn't outlive the delete.
   */
  private persistExecution(execInfo: ExecutionInfo): void {
    const id = execInfo.executionId;

    // Always release the streaming-buffer registration — this execution is
    // terminal in this process regardless of which branch below runs.
    this.streamableExecutionIds.delete(id);

    if (this.pendingDeletedExecutions.has(id)) {
      // The user deleted this execution while it was still running. Honor
      // that intent: skip save, skip cache write, finalize the streaming
      // buffer so it doesn't outlive the delete.
      this.pendingDeletedExecutions.delete(id);
      this.executions.delete(id);
      if (this.streamingFlusher) {
        this.streamingFlusher.finalize(id).catch(() => {});
      }
      return;
    }

    // Defensive clone. `liftPersistedMetadata` falls back to shallow copy
    // when metadata contains non-cloneable values (e.g., functions); the
    // shallow copy then rides through `execInfo.metadata` to here. A naive
    // `structuredClone(execInfo)` would throw at this point, crashing the
    // terminal hook. Fall back to a hand-rolled shallow snapshot that
    // omits the offending metadata so save still proceeds.
    let snapshot: ExecutionInfo;
    try {
      snapshot = structuredClone(execInfo);
    } catch {
      snapshot = {
        ...execInfo,
        events: [...execInfo.events],
        metadata: execInfo.metadata ? sanitizeMetadataForPersist(execInfo.metadata) : undefined,
      };
    }

    if (this.stateStore.saveExecution) {
      // Chain: save canonical executionHistory first, THEN finalize the
      // streaming buffer. Order matters — if the canonical save fails, we
      // want the streaming buffer left in place so the next process's
      // `recoverIncompleteStreams()` can still reconstruct the partial
      // ExecutionInfo. Releasing the buffer before the canonical save
      // would lose data on a failed save.
      //
      // The two failure modes are kept distinct:
      //   - saveExecution fails → buffer left in place (recovery posture).
      //   - saveExecution succeeds → finalize fails → orphan buffer that
      //     the next process's recoverIncompleteStreams will reap via its
      //     "canonical-exists, drop orphan" branch. Best-effort cleanup.
      //
      // Track the chain on `persistInflight` so `shutdown()` can await it
      // before closing the state store. Without this, a workflow that's
      // aborted by shutdown can race the connection-close: the abort
      // unwinds → workflow_end emits → persistExecution schedules
      // saveExecution → shutdown closes the connection → the detached save
      // fails. The chain is removed from the set in its `.finally`.
      const chain = this.stateStore
        .saveExecution(snapshot)
        .then(() => {
          // Save succeeded — fire finalize but isolate its failure mode
          // so it doesn't get conflated with save-failure in the outer catch.
          return this.streamingFlusher?.finalize(id).catch(() => {
            // Buffer becomes an orphan; recoverIncompleteStreams cleans up.
          });
        })
        .catch(() => {
          // Save failed; leave buffer in place for next-process recovery.
        })
        .then(() => undefined);
      this.persistInflight.add(chain);
      chain.finally(() => this.persistInflight.delete(chain));
    } else if (this.streamingFlusher) {
      // No saveExecution but streaming is enabled (custom store). Drop
      // the streaming buffer anyway — the workflow has completed in this
      // process, and the buffer wasn't going to be load-bearing without
      // a saveExecution path to gate against.
      const chain = this.streamingFlusher.finalize(id).catch(() => {});
      this.persistInflight.add(chain);
      chain.finally(() => this.persistInflight.delete(chain));
    }

    // Move from active to historical cache to bound active map growth.
    // Use the snapshot so the cached entry is not mutated by lingering closures.
    this.historicalExecutions.set(id, snapshot);
    this.executions.delete(id);
  }

  /** Register a workflow with the runtime. */
  register(workflow: AnyWorkflow): void {
    this.workflows.set(workflow.name, workflow);
  }

  /** Register standalone tools for Studio introspection and direct testing. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(...tools: Tool<any, any>[]): void {
    for (const t of tools) {
      this.tools.set(t.name, t);
    }
  }

  /** Register standalone agents for Studio playground and introspection. */
  registerAgent(...agents: Agent[]): void {
    for (const a of agents) {
      this.agents.set(a._name, a);
    }
  }

  // ── Introspection (used by Studio) ────────────────────────────────

  /** Get all registered workflow names. */
  getWorkflowNames(): string[] {
    return [...this.workflows.keys()];
  }

  /** Get a registered workflow by name. */
  getWorkflow(name: string): Workflow | undefined {
    return this.workflows.get(name);
  }

  /** Get all registered workflows. */
  getWorkflows(): Workflow[] {
    return [...this.workflows.values()];
  }

  /** Get all registered standalone tools. */
  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  /** Get a registered standalone tool by name. */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered standalone agents. */
  getAgents(): Agent[] {
    return [...this.agents.values()];
  }

  /** Get a registered standalone agent by name. */
  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /**
   * Register an eval config for Studio introspection and execution.
   * The config should be the result of `defineEval()` from `@axlsdk/eval`.
   * An optional `executeWorkflow` function can override the default behavior
   * of calling `runtime.execute()`.
   */
  registerEval(name: string, config: unknown, executeWorkflow?: EvalExecuteWorkflow): void {
    this.registeredEvals.set(name, { config, executeWorkflow });
  }

  /** Get metadata about all registered evals. */
  getRegisteredEvals(): Array<{
    name: string;
    workflow: string;
    dataset: string;
    scorers: string[];
  }> {
    const result: Array<{ name: string; workflow: string; dataset: string; scorers: string[] }> =
      [];
    for (const [name, { config }] of this.registeredEvals) {
      const cfg = config as {
        workflow?: string;
        dataset?: { name?: string };
        scorers?: Array<{ name?: string }>;
      };
      result.push({
        name,
        workflow: cfg.workflow ?? 'unknown',
        dataset: cfg.dataset?.name ?? 'unknown',
        scorers: (cfg.scorers ?? []).map((s) => s.name ?? 'unknown'),
      });
    }
    return result;
  }

  /** Get a registered eval config by name. */
  getRegisteredEval(
    name: string,
  ): { config: unknown; executeWorkflow?: EvalExecuteWorkflow } | undefined {
    return this.registeredEvals.get(name);
  }

  /** Run a registered eval by name. */
  async runRegisteredEval(
    name: string,
    options?: {
      metadata?: Record<string, unknown>;
      /** Called after each dataset item completes (execution + scoring). */
      onProgress?: (event: EvalProgressEventShape) => void;
      /** Abort signal — checked before starting each item. */
      signal?: AbortSignal;
      /**
       * When `true`, populate `EvalItem.traces` on every item (success + failure
       * paths). Forwards to `runEval({ captureTraces: true })`, which opens each
       * item's accounting scope with `trackOutcome({ captureTraces: true })`.
       * Verbose-mode `agent_call_start.data.messages` snapshots are stripped from
       * captured traces to keep memory bounded.
       */
      captureTraces?: boolean;
      /**
       * Forwarded to `runEval({ captureRequests })`. Requires
       * `config.diagnostics.artifacts`; without it the run fails fast with
       * `AxlError('DIAGNOSTICS_UNAVAILABLE')` before any provider call.
       */
      captureRequests?:
        | boolean
        | { maxRecordBytes?: number; maxRunBytes?: number; maxQueueBytes?: number };
    },
  ): Promise<unknown> {
    const entry = this.registeredEvals.get(name);
    if (!entry) throw new Error(`Eval "${name}" is not registered`);

    let result: unknown;

    if (entry.executeWorkflow) {
      // Use custom executeWorkflow if provided, injecting this runtime as second arg
      let runEvalFn: (
        config: unknown,
        executeFn: (
          input: unknown,
          runtime: unknown,
        ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
        runtime: unknown,
        evalOptions?: {
          onProgress?: (event: EvalProgressEventShape) => void;
          signal?: AbortSignal;
          captureTraces?: boolean;
          captureRequests?: unknown;
        },
      ) => Promise<unknown>;
      try {
        // @ts-expect-error — @axlsdk/eval is an optional peer dependency
        ({ runEval: runEvalFn } = await import('@axlsdk/eval'));
      } catch {
        throw new Error(
          'axl-eval is required for AxlRuntime.runRegisteredEval(). Install it with: npm install @axlsdk/eval',
        );
      }
      const originalExecuteFn = entry.executeWorkflow!;

      // Forward the callback VERBATIM. The runner owns measurement now: it opens
      // the accounting scope for each item, so a `cost`/`metadata` fallback
      // injected here would arrive as a caller report competing with the
      // measurement — the exact replacement precedence the 0.24 cutover removed.
      const wrappedExecuteFn = async (
        input: unknown,
        runtime: unknown,
      ): Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }> => {
        return originalExecuteFn(input, runtime as AxlRuntime);
      };

      result = await runEvalFn(entry.config, wrappedExecuteFn, this, {
        onProgress: options?.onProgress,
        signal: options?.signal,
        captureTraces: options?.captureTraces,
        captureRequests: options?.captureRequests,
      });
    } else {
      // Default: use runtime.eval() which creates its own executeWorkflow.
      // NOTE: this structural shape must stay in sync with the one on eval()
      // below and with EvalConfig in @axlsdk/eval (core can't import it). When
      // adding an EvalConfig field, update both copies.
      result = await this.eval(entry.config as RuntimeEvalConfigShape, {
        onProgress: options?.onProgress,
        signal: options?.signal,
        captureTraces: options?.captureTraces,
        captureRequests: options?.captureRequests,
      });
    }

    // Merge extra metadata if provided (e.g., runGroupId for multi-run)
    const resultObj = result as Record<string, unknown>;
    if (options?.metadata) {
      resultObj.metadata = {
        ...(resultObj.metadata as Record<string, unknown>),
        ...options.metadata,
      };
    }

    // Persist eval result to history (best-effort — don't lose the result on store errors)
    try {
      await this.saveEvalResult({
        id: (resultObj.id as string) ?? randomUUID(),
        eval: name,
        timestamp: Date.now(),
        data: structuredClone(result),
      });
    } catch {
      // Best-effort persistence — eval still succeeded
    }

    return result;
  }

  /** Get all execution info (running + completed + historical). */
  /** Normalize an execution loaded from a `StateStore` so the
   *  historical event union holds for downstream consumers
   *  (Studio aggregators, REST routes, redaction). Custom or legacy stores
   *  may persist rows without `events` (or with a non-array value) — without
   *  this guard, a single malformed row crashes every iterator over
   *  `exec.events` and takes down dependent features. Returns a normalized
   *  copy; logs at most one warning per `executionId`. */
  private normalizeStoredExecution(exec: HistoricalExecutionInfo): HistoricalExecutionInfo {
    if (!Array.isArray(exec.events)) {
      if (!this.warnedMalformedExecutions.has(exec.executionId)) {
        this.warnedMalformedExecutions.add(exec.executionId);
        console.warn(
          `[axl] StateStore returned execution ${exec.executionId} with non-array events ` +
            `(got ${exec.events === null ? 'null' : typeof exec.events}); coercing to []`,
        );
      }
      return normalizeHistoricalExecution({ ...exec, events: [] } as HistoricalExecutionInfo);
    }
    return normalizeHistoricalExecution(exec);
  }

  async getExecutions(): Promise<HistoricalExecutionInfo[]> {
    // Lazy-load historical executions from store on first access (once-guard)
    if (!this.historicalExecutionsLoadPromise && this.stateStore.listExecutions) {
      this.historicalExecutionsLoadPromise = this.stateStore
        .listExecutions()
        .then((stored) => {
          for (const exec of stored) {
            if (
              !this.executions.has(exec.executionId) &&
              !this.historicalExecutions.has(exec.executionId)
            ) {
              this.historicalExecutions.set(exec.executionId, this.normalizeStoredExecution(exec));
            }
          }
        })
        .catch((error) => {
          // Failed to load — reset so next call retries
          this.historicalExecutionsLoadPromise = null;
          throw error;
        });
    }
    if (this.historicalExecutionsLoadPromise) {
      await this.historicalExecutionsLoadPromise;
    }

    // Merge: in-memory takes precedence (has live data)
    const merged = new Map(this.historicalExecutions);
    for (const [id, exec] of this.executions) {
      merged.set(id, exec);
    }
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Create a WorkflowContext for ad-hoc use (evals, tool testing, prototyping).
   * The context has access to the runtime's providers, state store, MCP manager,
   * and automatically emits trace events and tracks cost.
   */
  createContext(options?: CreateContextOptions): WorkflowContext {
    assertNoRemovedObservationCallbacks(options);
    const executionId = randomUUID();
    const budgetLimit = options?.budget ? parseCost(options.budget) : Infinity;

    // Register with active cost scope for trackCost() attribution
    this.registerWithCostScope(executionId);

    return new WorkflowContext({
      input: undefined,
      executionId,
      metadata: options?.metadata,
      config: this.config,
      providerRegistry: this.providerRegistry,
      resolveProvider: (uri) => this.resolveProvider(uri),
      transcriptionProviderRegistry: this.transcriptionProviderRegistry,
      stateStore: this.stateStore,
      mcpManager: this.mcpManager,
      spanManager: this.spanManager,
      memoryManager: this.memoryManager,
      sessionHistory: options?.sessionHistory,
      signal: options?.signal,
      awaitHumanHandler: options?.awaitHumanHandler,
      _onDecisionCleanupFailed: (event) => this.emit('decision_cleanup_failed', event),
      eventStreamOptions: options?.events,
      onTrace: (event: AxlEvent) => {
        // Note: createContext flows do NOT append to streamingFlusher.
        // Ad-hoc contexts (tool tests, Studio playground, evals) have no
        // terminal `persistExecution` path that would finalize the
        // streaming buffer — allowing them to write would leave phantom
        // orphan buffers that recoverIncompleteStreams() later mis-recovers.
        this.emit('trace', event);
        this.outputAxlEvent(event);
      },
      budgetContext: {
        totalCost: 0,
        limit: budgetLimit,
        exceeded: false,
        policy: 'finish_and_stop',
        unpriced: false,
        unpricedCount: 0,
        unpricedWarned: false,
      },
    });
  }

  /** Register a custom provider instance. */
  registerProvider(name: string, provider: Provider): void {
    this.providerRegistry.registerInstance(name, provider);
  }

  /** Register a dedicated transcription adapter. It is never used for chat. */
  registerTranscriptionProvider(name: string, provider: TranscriptionProvider): void {
    this.transcriptionProviderRegistry.registerInstance(name, provider);
  }

  /**
   * Resolve a `provider:model` URI to a provider and model name.
   *
   * **The returned provider is a scoped FACADE, not the registered instance.**
   * It forwards everything to the adapter — custom properties and accessors,
   * class private-field methods, property writes, capability methods, ordinary
   * `instanceof` — while routing `chat`/`stream` through accounting and budget
   * admission whenever a `trackOutcome` scope is active. Outside a scope it
   * delegates verbatim.
   *
   * Identity is stable per runtime per adapter (repeated calls return the same
   * facade), but `resolveProvider(uri).provider === registeredInstance` is now
   * `false`. See `docs/migration/eval-accounting.md`.
   */
  resolveProvider(uri: string): { provider: Provider; model: string } {
    const { provider, model } = this.providerRegistry.resolve(uri, this.config);
    return { provider: this.scopedProvider(provider), model };
  }

  /** One facade per raw adapter per runtime, so repeated resolution is stable. */
  private scopedProvider(raw: Provider): Provider {
    const existing = this.scopedProviders.get(raw);
    if (existing) return existing;
    const facade = createScopedProvider(raw);
    this.scopedProviders.set(raw, facade);
    return facade;
  }

  /** Execute a workflow and return the result. */
  async execute(name: string, input: unknown, options?: ExecuteOptions): Promise<unknown> {
    const workflow = this.workflows.get(name);
    if (!workflow) {
      throw new Error(
        `Workflow "${name}" not registered. Available: ${[...this.workflows.keys()].join(', ')}`,
      );
    }

    // Validate input
    const validated = workflow.inputSchema.parse(input);
    const branchDrainTimeoutMs = resolveBranchDrainTimeoutMs(options?.branchDrainTimeoutMs);
    const executionId = randomUUID();
    const controller = new AbortController();
    this.abortControllers.set(executionId, controller);
    // Forward an external AbortSignal (if the caller passed one) into
    // our internal controller so `runtime.abort(executionId)` and the
    // user's own signal converge on a single shared abort path. Capture
    // the cleanup fn — it removes the listener on `options.signal` when
    // the workflow completes, which prevents listener accumulation when
    // a long-lived signal is reused across many `execute()` calls.
    const cleanupAbortForwarder = forwardAbortSignal(options?.signal, controller);

    // Register with active cost scope for trackCost() attribution
    this.registerWithCostScope(executionId);

    // Register for streaming-buffer durability BEFORE the first event
    // emission. Only ids registered here get appended to the streaming
    // flusher — createContext flows are deliberately excluded (no terminal
    // finalize path).
    if (this.streamingFlusher) {
      this.streamableExecutionIds.add(executionId);
    }

    // Create execution info. Persisted `metadata` strips internal control-
    // plane keys (sessionHistory, sessionId) and is structurally
    // cloned to isolate from caller mutation.
    const execInfo: ExecutionInfo = {
      executionId,
      workflow: name,
      status: 'running',
      eventSchemaVersion: 2,
      events: [],
      totalCost: 0,
      unpriced: false,
      startedAt: Date.now(),
      duration: 0,
      observation: { complete: true },
      metadata: liftPersistedMetadata(options?.metadata),
    };
    this.executions.set(executionId, execInfo);

    // Resolve session history from metadata if present. Note: this reads
    // from the ORIGINAL options.metadata (control-plane channel), not from
    // execInfo.metadata (filtered persisted channel).
    const sessionHistory = (options?.metadata?.sessionHistory as ChatMessage[]) ?? undefined;

    // Create workflow context
    const ctx = new WorkflowContext({
      input: validated,
      executionId,
      metadata: options?.metadata,
      config: this.config,
      providerRegistry: this.providerRegistry,
      resolveProvider: (uri) => this.resolveProvider(uri),
      transcriptionProviderRegistry: this.transcriptionProviderRegistry,
      sessionHistory,
      signal: controller.signal,
      eventStreamOptions: options?.events,
      branchDrainTimeoutMs,
      _onDecisionCleanupFailed: (event) => this.emit('decision_cleanup_failed', event),
      onTrace: (event: AxlEvent) => {
        // High-volume stream-only events (`token`, `partial_object`)
        // are never persisted, plus a bounded cap on the rest to avoid
        // OOM on pathological workloads (50 nested asks × 20-turn tool
        // loops can otherwise accumulate hundreds of MB before
        // terminal `done`). Trace channel + WS broadcast still see
        // every event; only the in-memory array is bounded.
        pushEventBounded(execInfo, event, this.maxEventsPerExecution);
        execInfo.totalCost += eventCostContribution(event);
        // Honest aggregate: one unpriced leaf makes `totalCost` a lower bound.
        if (isUnpricedLeaf(event)) execInfo.unpriced = true;
        // Streaming durability: in `state.persist: 'streaming'` mode the
        // flusher batches events to the store throughout the run, so a
        // mid-run crash leaves a recoverable buffer. No-op when
        // `persist === 'terminal'` (the back-compat default).
        if (this.streamableExecutionIds.has(executionId)) {
          this.streamingFlusher?.append(executionId, event);
        }
        this.emit('trace', event);
        this.outputAxlEvent(event);
        // Persist handoff records to session metadata. Records land on
        // `handoff_start` carrying source/target/mode/toAskId.
        // Duration backfill is mode-specific:
        //   - oneway:    target's `ask_end.duration` (the target's full work)
        //   - roundtrip: `handoff_return.data.duration` (round-trip wall-clock,
        //                includes pushing the result back into source's convo)
        // Both modes correlate to the target via `toAskId` (handoff_start)
        // matched against `ask_end.askId`.
        if (event.type === 'handoff_start') {
          const sessionId = options?.metadata?.sessionId as string | undefined;
          if (sessionId) {
            this.appendHandoffRecord(sessionId, {
              source: event.data.source,
              target: event.data.target,
              mode: event.data.mode,
              timestamp: event.timestamp,
              toAskId: event.toAskId,
            });
          }
        } else if (event.type === 'handoff_return') {
          const sessionId = options?.metadata?.sessionId as string | undefined;
          if (sessionId) {
            this.updateHandoffDuration(sessionId, {
              toAskId: event.toAskId,
              duration: event.data.duration,
            });
          }
        } else if (event.type === 'ask_end') {
          // Backfill duration for ONEWAY handoffs whose target just ended.
          // Oneway has no `handoff_return`; without this listener, the
          // record stays `duration: undefined`. Roundtrip records also
          // hit this path, but `handoff_return` fires AFTER the target's
          // `ask_end` and overwrites with the round-trip duration —
          // intentional (round-trip wall-clock is the more useful figure
          // for roundtrip).
          const sessionId = options?.metadata?.sessionId as string | undefined;
          if (sessionId && event.askId && typeof event.duration === 'number') {
            this.updateHandoffDuration(sessionId, {
              toAskId: event.askId,
              duration: event.duration,
            });
          }
        }
      },
      pendingDecisions: this.pendingDecisionResolvers,
      awaitHumanHandler: options?.awaitHumanHandler,
      stateStore: this.stateStore,
      workflowName: name,
      mcpManager: this.mcpManager,
      memoryManager: this.memoryManager,
      spanManager: this.spanManager,
      budgetContext: {
        totalCost: 0,
        limit: Infinity,
        exceeded: false,
        policy: 'finish_and_stop',
        unpriced: false,
        unpricedCount: 0,
        unpricedWarned: false,
      },
    });

    return this.spanManager.withSpanAsync(
      'axl.workflow.execute',
      {
        'axl.workflow.name': name,
        'axl.execution.id': executionId,
        'axl.workflow.input_hash': hashInput(validated),
      },
      (span) =>
        this.runWorkflowBody({
          workflow,
          ctx,
          execInfo,
          validated,
          span,
          cleanupAbortForwarder,
        }),
    );
  }

  /** Execute a workflow and return a stream. */
  stream(name: string, input: unknown, options?: ExecuteOptions): AxlStream {
    const branchDrainTimeoutMs = resolveBranchDrainTimeoutMs(options?.branchDrainTimeoutMs);
    // Forward `events` config to BOTH the AxlStream's internal bus (queue
    // cap on the wire) and the WorkflowContext's `ctx.events` bus (queue
    // cap inside the workflow). They're independent buses but share the
    // same configured behavior.
    const axlStream = new AxlStream(options?.events);
    const controller = new AbortController();

    // Cancel workflow when consumer disconnects (stops reading the stream)
    axlStream.on('close', () => controller.abort());
    // Forward an external AbortSignal into our internal controller so
    // both `runtime.abort(executionId)` and the user's own signal
    // converge on a single shared abort path. Capture the cleanup fn —
    // it removes the listener on `options.signal` when the workflow
    // settles, preventing listener accumulation when a long-lived
    // signal is reused across many `stream()` calls.
    const cleanupAbortForwarder = forwardAbortSignal(options?.signal, controller);

    // Generate executionId BEFORE the async closure so it's available on
    // terminal `done` / `error` events even when `run()` throws early
    // (e.g., unregistered workflow, input validation failure). Review S4:
    // previously `_done(result, execInfo?.executionId ?? '')` sent an
    // empty-string sentinel in that path, which broke consumers
    // correlating the terminal event with the execution.
    const executionId = randomUUID();
    this.abortControllers.set(executionId, controller);
    // `execInfo` is closure-captured for the outer `.catch` so it can
    // tell whether the early-throw safety net needs to fire (it's
    // allocated inside `run()` — the catch path is defensive about
    // running before `execInfo` is assigned).
    let execInfo: ExecutionInfo | undefined;
    let wfCtx: WorkflowContext | undefined;

    const run = async () => {
      const workflow = this.workflows.get(name);
      if (!workflow) throw new Error(`Workflow "${name}" not registered`);

      const validated = workflow.inputSchema.parse(input);
      const sessionHistory = (options?.metadata?.sessionHistory as ChatMessage[]) ?? undefined;

      // Register with active cost scope for trackCost() attribution
      this.registerWithCostScope(executionId);

      // Register for streaming-buffer durability BEFORE the first event
      // emission (mirrors execute()).
      if (this.streamingFlusher) {
        this.streamableExecutionIds.add(executionId);
      }

      // Create execution info for stream executions. Persisted `metadata`
      // strips internal control-plane keys and is structurally cloned.
      execInfo = {
        executionId,
        workflow: name,
        status: 'running',
        eventSchemaVersion: 2,
        events: [],
        totalCost: 0,
        unpriced: false,
        startedAt: Date.now(),
        duration: 0,
        observation: { complete: true },
        metadata: liftPersistedMetadata(options?.metadata),
      };
      this.executions.set(executionId, execInfo);

      const context = new WorkflowContext({
        input: validated,
        executionId,
        metadata: options?.metadata,
        config: this.config,
        providerRegistry: this.providerRegistry,
        resolveProvider: (uri) => this.resolveProvider(uri),
        transcriptionProviderRegistry: this.transcriptionProviderRegistry,
        sessionHistory,
        signal: controller.signal,
        eventStreamOptions: options?.events,
        branchDrainTimeoutMs,
        _onDecisionCleanupFailed: (event) => this.emit('decision_cleanup_failed', event),
        // Transport mode is explicit internal state. It is inherited by child
        // contexts and does not allocate an unconsumed ctx.events queue.
        _forceStreaming: true,
        onTrace: (event: AxlEvent) => {
          // High-volume stream-only events never persist; remaining
          // structural events are bounded by maxEventsPerExecution. See
          // execute() for full rationale.
          pushEventBounded(execInfo!, event, this.maxEventsPerExecution);
          execInfo!.totalCost += eventCostContribution(event);
          if (isUnpricedLeaf(event)) execInfo!.unpriced = true;
          if (this.streamableExecutionIds.has(executionId)) {
            this.streamingFlusher?.append(executionId, event);
          }
          this.emit('trace', event);
          this.outputAxlEvent(event);
          // Single fan-out: every event flows verbatim to the wire. The
          // legacy translation layer (which derived StreamEvent shapes
          // like `agent_end` / `tool_result` / `step` and dropped fields
          // along the way) is gone — consumers receive the full AxlEvent.
          axlStream._push(event);

          // Side effect: persist handoff records to session metadata.
          // Mirrors the non-streaming path. See the comment block on the
          // execute() onTrace handler for duration semantics.
          if (event.type === 'handoff_start') {
            const sessionId = options?.metadata?.sessionId as string | undefined;
            if (sessionId) {
              this.appendHandoffRecord(sessionId, {
                source: event.data.source,
                target: event.data.target,
                mode: event.data.mode,
                timestamp: event.timestamp,
                toAskId: event.toAskId,
              });
            }
          } else if (event.type === 'handoff_return') {
            const sessionId = options?.metadata?.sessionId as string | undefined;
            if (sessionId) {
              this.updateHandoffDuration(sessionId, {
                toAskId: event.toAskId,
                duration: event.data.duration,
              });
            }
          } else if (event.type === 'ask_end') {
            const sessionId = options?.metadata?.sessionId as string | undefined;
            if (sessionId && event.askId && typeof event.duration === 'number') {
              this.updateHandoffDuration(sessionId, {
                toAskId: event.askId,
                duration: event.duration,
              });
            }
          }
        },
        pendingDecisions: this.pendingDecisionResolvers,
        awaitHumanHandler: options?.awaitHumanHandler,
        stateStore: this.stateStore,
        workflowName: name,
        mcpManager: this.mcpManager,
        memoryManager: this.memoryManager,
        spanManager: this.spanManager,
        budgetContext: {
          totalCost: 0,
          limit: Infinity,
          exceeded: false,
          policy: 'finish_and_stop',
          unpriced: false,
          unpricedCount: 0,
          unpricedWarned: false,
        },
      });

      wfCtx = context;

      return this.spanManager.withSpanAsync(
        'axl.workflow.execute',
        {
          'axl.workflow.name': name,
          'axl.execution.id': executionId,
          'axl.workflow.input_hash': hashInput(validated),
        },
        (span) =>
          this.runWorkflowBody({
            workflow,
            ctx: context,
            execInfo: execInfo!,
            validated,
            span,
            cleanupAbortForwarder,
          }),
      );
    };

    run()
      .then((result) => axlStream._done(result, executionId))
      .catch((err) => {
        // Early-throw safety net: if `runWorkflowBody` was never reached
        // (input parse, ctx construction, or registry lookup threw before
        // it ran), `execInfo.status` is still 'running' — the helper's
        // lifecycle emit/persist/cleanup didn't happen. Update + persist
        // here. If the helper DID run, it left status as 'failed' and
        // already persisted; we skip redundant work.
        if (execInfo && execInfo.status === 'running') {
          execInfo.status = 'failed';
          execInfo.completedAt = Date.now();
          execInfo.duration = execInfo.completedAt - execInfo.startedAt;
          execInfo.error = executionErrorProjection(wfCtx, err).message;
          // No `ctx` available on this path — `wfCtx` lives inside the
          // run() closure and was never assigned to a closure variable.
          // workflow_start was also never emitted (helper hadn't run),
          // so the start↔end pairing invariant holds: neither emitted.
          // `isAbortError` doesn't apply here either: `aborted: true` is
          // documented as "user-driven cancellation that reached an
          // emitted workflow_end". With no workflow_end, there's no
          // place to set the flag.
          this.persistExecution(execInfo);
        }
        // Clean up the abort controller even on pre-execInfo throws
        // (e.g., "workflow not registered") — the helper's `finally`
        // clears it on the success path, but early-throw never reaches
        // the helper. Same for the abort-forwarder cleanup; without
        // this, a "workflow not registered" thrown synchronously would
        // leak a listener on the user's signal forever.
        this.abortControllers.delete(executionId);
        cleanupAbortForwarder();
        const originalError = err instanceof Error ? err : new Error(String(err));
        const projection = executionErrorProjection(wfCtx, err);
        axlStream._error(originalError, executionId, projection.message, projection.name);
      });

    return axlStream;
  }

  /** Create or resume a session. */
  session(id: string, options?: SessionOptions): Session {
    return new Session(id, this, this.stateStore, options);
  }

  /** @internal Serialize work per session id within this runtime instance.
   *  Subsequent calls await the prior task's settlement (success or failure)
   *  before running. Used by `Session.send` / `Session.stream` / `end` /
   *  `fork` to eliminate read-modify-write races on `StateStore.saveSession`
   *  (and on `delete`/`getSession` ordering vs in-flight saves).
   *
   *  ⚠️ NOT REENTRANT. Calling this from inside an `fn` already running
   *  under `_serializeSession(sameId, ...)` will deadlock — the inner
   *  call awaits the outer's settlement, the outer awaits the inner's
   *  return. `Session.fork` deliberately calls with TWO different ids
   *  (source and target) and never the same id twice. Any future caller
   *  must follow the same rule. */
  async _serializeSession<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(id);
    // Emit a runtime-level event when a lock is already held so users
    // debugging "why is my session slow?" can see the queueing without
    // guessing. Listen via `runtime.on('session_lock_contended', ...)`.
    // Cheap: only fires when prev exists, which means the id is in
    // active use.
    if (prev !== undefined) {
      this.emit('session_lock_contended', { sessionId: id });
    }
    const base = prev ?? Promise.resolve();
    // Run fn after prev settles, regardless of how prev settled. `ours`
    // carries fn's value/error through to the caller.
    const ours = base.then(fn, fn);
    // The chain entry is a void-typed, error-swallowed handle so the next
    // caller awaits it without inheriting our success value or rejection.
    const chained = ours.then(
      () => {},
      () => {},
    );
    this.sessionLocks.set(id, chained);
    void chained.finally(() => {
      // Only drop the entry if no successor has overwritten it.
      if (this.sessionLocks.get(id) === chained) {
        this.sessionLocks.delete(id);
      }
    });
    return ours;
  }

  /** Gracefully shut down the runtime, aborting in-flight executions and
   *  closing state stores and MCP servers. Drains in-flight per-session
   *  work (Session.send / Session.stream) before closing the state store.
   *
   *  This is a drain of EXISTING work, not a barrier against new calls —
   *  callers should stop accepting work (e.g., close their HTTP server)
   *  before invoking `shutdown()`. A `Session.send` invoked after the
   *  drain snapshot is taken can still race a closed state store. */
  async shutdown(): Promise<void> {
    // Abort all in-flight executions
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    // Stop the artifact sweeper before anything else touches the state store —
    // a sweep that fires mid-teardown would query a closing connection.
    for (const timer of this.artifactRenewals.values()) clearInterval(timer);
    this.artifactRenewals.clear();
    if (this.artifactSweepTimer) {
      clearInterval(this.artifactSweepTimer);
      this.artifactSweepTimer = undefined;
    }

    // Drain in-flight per-session work before closing the state store —
    // otherwise a Session.send/stream that's mid-save will write to a
    // closed SQLite/Redis connection. The chain entries are void+swallowed
    // (see _serializeSession), so allSettled is sufficient.
    if (this.sessionLocks.size > 0) {
      await Promise.allSettled([...this.sessionLocks.values()]);
    }

    const errors: Error[] = [];
    const safeClose = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`));
      }
    };

    // Drain the streaming flusher BEFORE closing the state store — the
    // flush writes to the store, so closing first would lose the last
    // batch (up to 1s of events by default).
    if (this.streamingFlusher) {
      await safeClose('streamingFlusher', () => this.streamingFlusher!.flushAll());
    }

    // Drain in-flight `persistExecution` chains. These are detached from
    // their triggering workflow (fire-and-forget save→finalize), so abort
    // of in-flight executions schedules saves that the StreamingFlusher
    // drain above doesn't know about. Without this, the StateStore can
    // close while the chain's `saveExecution` is mid-flight, losing the
    // canonical executionHistory row for an aborted workflow.
    if (this.persistInflight.size > 0) {
      await safeClose('persistInflight', () =>
        Promise.allSettled([...this.persistInflight]).then(() => undefined),
      );
    }

    if (this.mcpManager) await safeClose('mcpManager', () => this.mcpManager!.shutdown());
    if (this.memoryManager) await safeClose('memoryManager', () => this.memoryManager!.close());
    if (this.stateStore.close) await safeClose('stateStore', () => this.stateStore.close!());
    await safeClose('spanManager', () => this.spanManager.shutdown());

    if (errors.length > 0) {
      throw new Error(
        `shutdown encountered ${errors.length} error(s): ${errors.map((e) => e.message).join('; ')}`,
      );
    }
  }

  /**
   * Recover executions whose process died mid-run when `state.persist:
   * 'streaming'` was configured. Synthesizes a partial `ExecutionInfo`
   * from the streaming buffer for each — `status: 'failed'`, error
   * `'process terminated'` — registers them in the historical cache so
   * they show up in `getExecutions()`, persists them via the store's
   * `saveExecution`, and finalizes the streaming buffer.
   *
   * Idempotent — if the streaming buffer is already gone (or
   * `listStreamingExecutions` is empty), this is a no-op. Returns the
   * list of recovered `ExecutionInfo`s for caller introspection.
   *
   * Wire this into your process startup AFTER `runtime.getExecutions()`
   * has lazy-loaded the historical cache. Order matters: completed
   * executions already in the store should not be overwritten by a
   * stale streaming buffer that the previous process didn't get to
   * finalize. The implementation checks the historical store before
   * synthesizing, so a re-run is safe.
   */
  async recoverIncompleteStreams(): Promise<HistoricalExecutionInfo[]> {
    if (!this.stateStore.listStreamingExecutions || !this.stateStore.getStreamingEvents) {
      // Store doesn't support streaming — nothing to recover.
      return [];
    }

    const ids = await this.stateStore.listStreamingExecutions();
    if (ids.length === 0) return [];

    // Ensure historicalExecutions is populated so we don't double-recover
    // an execution that already has a complete `executionHistory` blob.
    // (Race: a previous process might have finalized after writing
    // saveExecution, but our streaming list still has the entry. Defensive
    // check.)
    await this.getExecutions();

    const recovered: HistoricalExecutionInfo[] = [];
    for (const id of ids) {
      // Liveness check: never recover an execution that's actively running
      // in THIS process. The streaming flusher may have written a batch
      // before saveExecution lands, so recovery would mistake the live run
      // for a crashed one — synthesize a `failed` record, delete the live
      // buffer, and leave the actual workflow about to re-create both.
      // Cross-process recovery (workflow live in process A, recovery in
      // process B) requires a Redis-side lease and is out of scope for
      // this contract: callers must wire recovery into startup BEFORE
      // accepting new work.
      if (this.executions.has(id) || this.streamableExecutionIds.has(id)) {
        continue;
      }

      // If a canonical execution already exists, just drop the orphan buffer.
      const existing = this.historicalExecutions.get(id);
      if (existing) {
        await this.stateStore.finalizeStreamingEvents?.(id);
        continue;
      }

      const events = await this.stateStore.getStreamingEvents(id);
      if (events.length === 0) {
        // Empty buffer — drop the orphan index entry.
        await this.stateStore.finalizeStreamingEvents?.(id);
        continue;
      }

      const eventSchemaVersion = getEventSchemaVersion(events[0]);
      for (const event of events) {
        if (getEventSchemaVersion(event) !== eventSchemaVersion) {
          throw new Error(`Streaming buffer ${id} contains mixed event schema versions`);
        }
      }

      // Bound the synthesized events array to the configured cap so a
      // crashed run with hundreds of thousands of buffered events can't
      // resurrect as an unbounded ExecutionInfo. Mirrors `pushEventBounded`'s
      // sentinel behavior — truncation marker as the last entry.
      const boundedEvents = boundRecoveredEvents(events, this.maxEventsPerExecution);

      // Synthesize a partial ExecutionInfo. We don't have the original
      // input or workflow name on hand, but we can pull them off events
      // when available — `workflow_start` is the only event type the
      // emitter auto-stamps with the workflow name, so prefer it. Falling
      // back to events[0] is fragile because the first ASK-scoped event
      // (ask_start) may precede workflow_start in unusual scenarios.
      const workflowStartEvent = boundedEvents.find((e) => e.type === 'workflow_start');
      const lastEvent = boundedEvents[boundedEvents.length - 1];
      const startedAt = workflowStartEvent?.timestamp ?? boundedEvents[0]?.timestamp ?? Date.now();
      const completedAt = lastEvent.timestamp ?? startedAt;
      const workflowName = workflowStartEvent?.workflow ?? RECOVERED_UNKNOWN_WORKFLOW;

      // Sum cost from cost-bearing leaf events; flag if any was unpriced so the
      // recovered `totalCost` carries the same lower-bound signal as a live run.
      const totalCost = boundedEvents.reduce((sum, e) => sum + eventCostContribution(e), 0);
      const unpriced = boundedEvents.some(isUnpricedLeaf);

      const executionBase = {
        executionId: id,
        workflow: workflowName,
        status: 'failed' as const,
        events: boundedEvents,
        totalCost,
        unpriced,
        startedAt,
        completedAt,
        duration: completedAt - startedAt,
        error: 'process terminated (recovered from streaming buffer)',
      };
      const synthesized: HistoricalExecutionInfo =
        eventSchemaVersion === 2
          ? {
              ...executionBase,
              eventSchemaVersion: 2,
              events: boundedEvents as AxlEventV2[],
              observation: { complete: false, reason: 'process_interrupted' },
            }
          : {
              ...executionBase,
              eventSchemaVersion: 1,
              events: boundedEvents as LegacyAxlEventV1[],
            };

      // Persist + register. CRITICAL: only delete the streaming buffer
      // AFTER saveExecution succeeds. If saveExecution throws (Redis flaky
      // during recovery), we'd otherwise lose the only on-disk record by
      // deleting the buffer in the next finalize call. Mirrors the live-
      // workflow `persistExecution` save→finalize chain.
      if (this.stateStore.saveExecution) {
        try {
          await this.stateStore.saveExecution(synthesized);
        } catch (err) {
          console.error(
            `[axl] recoverIncompleteStreams: failed to save synthesized execution ` +
              `${id}: ${err instanceof Error ? err.message : String(err)}. ` +
              `Streaming buffer left in place for next recovery attempt.`,
          );
          continue;
        }
      }
      this.historicalExecutions.set(id, synthesized);
      await this.stateStore.finalizeStreamingEvents?.(id);
      recovered.push(synthesized);
    }

    return recovered;
  }

  /** Abort a running execution by its ID. */
  abort(executionId: string): void {
    const controller = this.abortControllers.get(executionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(executionId);
    }
  }

  /** Get execution details by ID. */
  async getExecution(executionId: string): Promise<HistoricalExecutionInfo | undefined> {
    // Check active in-memory executions first
    const inMemory = this.executions.get(executionId);
    if (inMemory) return inMemory;

    // Check historical cache
    const cached = this.historicalExecutions.get(executionId);
    if (cached) return cached;

    // Fall through to store
    if (this.stateStore.getExecution) {
      const stored = await this.stateStore.getExecution(executionId);
      if (stored) {
        const normalized = this.normalizeStoredExecution(stored);
        this.historicalExecutions.set(executionId, normalized);
        return normalized;
      }
    }

    return undefined;
  }

  /** Save an eval result to history. */
  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    // Only an artifact this entry OWNS may be committed against it. A result
    // carrying someone else's id — a degraded rescore naming its source, an
    // imported blob — would otherwise rewrite that artifact's retention.
    const artifactId = await this.ownedArtifactId(this.artifactIdOf(entry.data), entry.id);
    // A pointer to an artifact that is already gone (swept, or removed out of
    // band) must not be persisted as if it were readable.
    if (!artifactId) this.downgradeDiagnostics(entry);

    // Add to in-memory cache (newest first). Replacing rather than prepending:
    // a re-save of an existing id would otherwise leave two entries, and every
    // by-id read would serve whichever landed first.
    this.evalHistory = this.evalHistory.filter((e) => e.id !== entry.id);
    this.evalHistory.unshift(entry);
    // An explicit save is a deliberate write, so it clears any tombstone: the
    // caller is asserting this id exists again.
    this.deletedEvalIds.delete(entry.id);

    // Persist to store
    if (this.stateStore.saveEvalResult) {
      try {
        await this.stateStore.saveEvalResult(entry);
      } catch (error) {
        // The owner row does not exist, so the staged artifact must not survive
        // as an orphan. Rollback is best effort; the SAVE failure is what the
        // caller needs to see, not a cleanup failure layered over it.
        if (artifactId && this.artifactStore) {
          await this.artifactStore.rollback(artifactId).catch(() => undefined);
        }
        throw error;
      }
    }

    // Ownership becomes real only now that the history row exists. Mirroring the
    // store's own retention onto the manifest is what lets a Redis deployment —
    // whose server-side TTL can never notify a filesystem — still expire the
    // bytes it owns.
    if (artifactId && this.artifactStore) {
      const retention = await this.stateStore.getEvalRetention?.(entry.id);
      const committed = await this.artifactStore.commit(artifactId, {
        ...(retention?.expiresAt !== undefined ? { expiresAt: retention.expiresAt } : {}),
      });
      if (!committed.ok) {
        // The artifact vanished between the ownership check and the commit.
        // The row is already stored, so correct it in place rather than leaving
        // a published result promising evidence it cannot serve.
        this.downgradeDiagnostics(entry);
        // Same rule as the sweep's write-back: the row was saved a moment ago,
        // but "a moment ago" is not proof it is still there, and a blind
        // re-save would resurrect one deleted or expired in between.
        await this.persistCorrectedRow(entry).catch(() => undefined);
      }
    }

    // Emit for live aggregation (e.g., Studio eval trends)
    this.emit('eval_result', entry);
  }

  /**
   * Delete an execution from history by id. Removes from the active map (if
   * still running), the historical cache, the configured StateStore, AND
   * any execution-scoped side state — pending awaitHuman decisions,
   * resolver maps, streaming buffer registration, in-flight abort controller.
   * Returns true if an entry was actually removed from any of the three
   * primary surfaces (active map, historical cache, store).
   *
   * In-flight handling: if the execution is still running, this method
   * **aborts** it (via the registered abort controller) AND marks the id for
   * skip-on-persist so the workflow's eventual `workflow_end` doesn't
   * resurrect the row. The workflow itself terminates normally — callers
   * iterating the returned `AxlStream` will see the abort flow through. If
   * you need a hard hand-off (delete completes before the workflow tears
   * down), call `runtime.abort(id)` and `await` the stream/execute promise
   * before calling this. `streamableExecutionIds` is cleared eagerly so
   * events emitted during the wind-down don't re-create the streaming
   * buffer in the store after the deleteExecution-issued DEL.
   *
   * Audit trail: emits `execution_deleted` on the runtime's `EventEmitter`
   * with `{ executionId, wasActive, hadPendingDecision }` so compliance
   * apps can subscribe via `runtime.on('execution_deleted', ...)` for a
   * "who deleted what when" log without wrapping this method. Fires
   * regardless of whether the id was actually present.
   *
   * Use cases: GDPR right-to-be-forgotten, operator-driven cleanup of
   * specific runs (e.g. a workflow that recorded PII the user requested
   * scrubbed). For bulk eviction by age, use a `RedisStore` TTL instead
   * (`defaultTtl` / `ttls.executionHistory`).
   */
  async deleteExecution(id: string): Promise<boolean> {
    const wasActive = this.executions.has(id);
    const pendingDecisionResolver = this.pendingDecisionResolvers.get(id);
    const hadPendingDecision = pendingDecisionResolver !== undefined;

    // Auto-abort: the doc-claimed "doesn't abort" behavior leads to
    // resurrection — the workflow keeps running, hits `persistExecution`,
    // and re-creates the row the caller just deleted. Abort + mark-for-skip
    // honors the caller's delete intent without leaving the workflow
    // mid-tool-call.
    if (wasActive) {
      this.pendingDeletedExecutions.add(id);
      // Eager clear: between this method returning and persistExecution
      // running, the in-flight workflow's wind-down events would otherwise
      // re-create the streaming buffer in the store right after the
      // upcoming `stateStore.deleteExecution` DEL. Clearing the
      // streamable-set entry prevents those events from being appended.
      this.streamableExecutionIds.delete(id);
      const controller = this.abortControllers.get(id);
      if (controller) {
        controller.abort();
      }
    }

    // Stop new public resolutions immediately, but keep the cleanup record
    // discoverable until WorkflowContext's finally block removes it. Every
    // concurrent delete must be able to join the same barrier.
    if (pendingDecisionResolver) pendingDecisionResolver.cancelled = true;

    // A total store deletion must linearize after any approval mutation that
    // already claimed this execution. Cleanup can outlive the active-execution
    // map (for example after a bounded branch drain), so join whenever the
    // resolver exists rather than conditioning on `wasActive`.
    if (pendingDecisionResolver) {
      await pendingDecisionResolver.cleanupFinished;
      if (this.pendingDecisionResolvers.get(id) === pendingDecisionResolver) {
        this.pendingDecisionResolvers.delete(id);
      }
    }

    // Lazy-load just THIS id from the store (cheaper than the full list).
    // Without this, a "delete" on something only-in-store leaves a
    // duplicate in memory on the next list call after lazy-load fires.
    // Also captures the workflow name BEFORE delete so the audit event
    // can carry it — compliance pipelines categorize by workflow.
    const existing = await this.getExecution(id);
    const workflow = existing?.workflow;

    const removedFromActive = this.executions.delete(id);
    const removedFromHistorical = this.historicalExecutions.delete(id);

    let removedFromStore = false;
    if (this.stateStore.deleteExecution) {
      removedFromStore = await this.stateStore.deleteExecution(id);
    }

    // Audit signal. Emit regardless of whether anything was removed so
    // compliance consumers see attempted deletes too (useful for "user
    // tried to delete X but it didn't exist" audit paths). Synchronous
    // emit so subscribers run before the method returns; throwing
    // listeners surface to the caller (mirrors EventEmitter defaults).
    // `workflow` is undefined when the delete was against an unknown id.
    this.emit('execution_deleted', {
      executionId: id,
      workflow,
      wasActive,
      hadPendingDecision,
      removed: removedFromActive || removedFromHistorical || removedFromStore,
    });

    return removedFromActive || removedFromHistorical || removedFromStore;
  }

  /**
   * Delete an eval history entry by id. Removes from in-memory cache and
   * the configured StateStore. Returns true if an entry was actually removed.
   *
   * Ensures lazy-loaded history is loaded first so the in-memory cache and
   * the store can't drift apart on the deletion path.
   *
   * Emits `eval_deleted` on the runtime's `EventEmitter` with
   * `{ id, eval, removed }`. Fires on every call — including attempts
   * against unknown ids (`removed: false`) — symmetric to `execution_deleted`.
   * Studio's eval-trends aggregator subscribes to this event so deleted
   * runs don't linger in the trends panel for up to 5 minutes (until the
   * next periodic rebuild).
   */
  async deleteEvalResult(id: string): Promise<boolean> {
    // Force a lazy-load so the in-memory cache reflects everything in the
    // store before we mutate it.
    await this.getEvalHistory();

    // Capture the eval name from the existing entry BEFORE delete so the
    // audit event can carry it. `evalName` is undefined when the delete
    // was against an unknown id.
    const existing = this.evalHistory.find((e) => e.id === id);
    const evalName = existing?.eval;
    const artifactId = this.artifactIdOf(existing?.data);

    // Confirmed ownership only: a result carrying another run's artifact id
    // must not be able to delete that run's evidence.
    const ownedArtifactId = await this.ownedArtifactId(artifactId, id);

    const beforeLength = this.evalHistory.length;
    // Tombstoned BEFORE the store delete, not after: a correction already in
    // flight (the sweep's downgrade, a commit failure's) reaches its write
    // while this method is still awaiting the store, and the store cannot
    // refuse a write for a row it has not removed yet. The intent is what
    // makes the delete win.
    this.forgetEvalRow(id);
    const removedFromMemory = this.evalHistory.length < beforeLength;

    // The row goes FIRST, then the deletion intent. Writing the intent first
    // looked safer and is not: a row delete that then fails leaves an intent
    // the sweeper honours within a minute, destroying the evidence of a result
    // the caller was just told had NOT been deleted. Crash-safety in the other
    // direction is already covered — reconciliation reclaims any committed
    // artifact whose owner row is gone.
    let removedFromStore = false;
    if (this.stateStore.deleteEvalResult) {
      removedFromStore = await this.stateStore.deleteEvalResult(id);
    }

    // The bytes are part of the delete, not an afterthought: this method reports
    // success only once they are gone. A failure here surfaces to the caller
    // with the `delete_pending` intent recorded, so a retry or the next
    // reconciliation sweep completes it.
    if (ownedArtifactId && this.artifactStore) {
      this.stopArtifactRenewal(ownedArtifactId);
      await this.artifactStore.markDeletePending(ownedArtifactId);
      await this.artifactStore.delete(ownedArtifactId);
    }

    const removed = removedFromMemory || removedFromStore;

    // Audit signal — symmetric to `execution_deleted`. Synchronous emit so
    // subscribers run before the method returns; throwing listeners surface
    // to the caller (mirrors EventEmitter defaults). Studio aggregators
    // listen for this to invalidate eval-trends snapshots on delete.
    this.emit('eval_deleted', {
      id,
      eval: evalName,
      removed,
    });

    return removed;
  }

  /** Get eval result history (most recent first). */
  async getEvalHistory(): Promise<EvalHistoryEntry[]> {
    // Lazy-load from store on first access (once-guard)
    if (!this.evalHistoryLoadPromise && this.stateStore.listEvalResults) {
      this.evalHistoryLoadPromise = this.stateStore
        .listEvalResults()
        .then((stored) => {
          // Merge: stored entries not already in memory
          const ids = new Set(this.evalHistory.map((e) => e.id));
          for (const entry of stored) {
            // The snapshot may predate an eviction that happened while it was
            // in flight, and re-adding a row the store has dropped is the same
            // staleness eviction exists to end.
            if (!ids.has(entry.id) && !this.deletedEvalIds.has(entry.id)) {
              this.evalHistory.push(entry);
            }
          }
          // Re-sort by timestamp descending
          this.evalHistory.sort((a, b) => b.timestamp - a.timestamp);
        })
        .catch(() => {
          // Failed to load — reset so next call retries
          this.evalHistoryLoadPromise = null;
        });
    }
    if (this.evalHistoryLoadPromise) {
      await this.evalHistoryLoadPromise;
    }
    return [...this.evalHistory];
  }

  /**
   * One eval history entry by id, or `undefined`.
   *
   * A read that wants one entry should not have to materialize the whole
   * history to find it. Studio's diagnostics routes resolve an artifact through
   * a history id on every request, and `getEvalHistory()` copies the entire
   * array — every result's full `data` blob — before the caller discards all
   * but one of them.
   *
   * The lazy first load is still whole-history (that is how the cache is
   * populated); what this avoids is paying for a copy of it per request.
   *
   * The row is confirmed against the store's retention view before it is
   * served, and dropped when the store says it is gone. The cache outlives
   * whatever the store decided — a Redis TTL that elapsed, a delete elsewhere —
   * and this is the read a rescore resolves its SOURCE through, copying that
   * row's items into a brand-new result with a brand-new retention window. An
   * expired run could otherwise be republished indefinitely, one rescore at a
   * time. `getEvalHistory()` is still served from the cache unconfirmed; the
   * per-row check is affordable here because it is one row.
   */
  async getEvalResult(id: string): Promise<EvalHistoryEntry | undefined> {
    if (this.deletedEvalIds.has(id)) return undefined;
    let entry = this.evalHistory.find((e) => e.id === id);
    if (!entry) {
      // Not in memory yet: make sure the store has been read at least once.
      await this.getEvalHistory();
      entry = this.evalHistory.find((e) => e.id === id);
    }
    if (!entry) return undefined;
    const retention = await this.stateStore.getEvalRetention?.(id);
    // A store with no retention view has nothing to contradict the cache with.
    if (!retention) return entry;
    const expired = retention.expiresAt !== undefined && retention.expiresAt <= Date.now();
    if (!retention.exists || expired) {
      this.forgetEvalRow(id);
      return undefined;
    }
    return entry;
  }

  /** List pending human decisions. */
  async getPendingDecisions(): Promise<PendingDecision[]> {
    return this.stateStore.getPendingDecisions();
  }

  /** Resolve a pending human decision. */
  async resolveDecision(executionId: string, decision: HumanDecision): Promise<void> {
    decision = parseHumanDecision(decision);
    let resolver = this.pendingDecisionResolvers.get(executionId);
    if (resolver) {
      if (resolver.cancelled) {
        throw new AxlError(
          'PENDING_DECISION_NOT_FOUND',
          `The pending human decision for execution "${executionId}" is no longer active.`,
        );
      }
      await resolver.ready;
      if (
        resolver.cancelled ||
        resolver.state !== 'pending' ||
        this.pendingDecisionResolvers.get(executionId) !== resolver
      ) {
        throw new AxlError(
          'PENDING_DECISION_NOT_FOUND',
          `The pending human decision for execution "${executionId}" is no longer active.`,
        );
      }
    }
    if (!resolver) {
      const pending = await this.stateStore.getPendingDecisions();
      // A store implementation can make the row visible before its async
      // save call resumes and registers the in-process continuation. Re-read
      // after the await so polling callers don't get a false cross-process 409.
      resolver = this.pendingDecisionResolvers.get(executionId);
      if (resolver) {
        if (resolver.cancelled) {
          throw new AxlError(
            'PENDING_DECISION_NOT_FOUND',
            `The pending human decision for execution "${executionId}" is no longer active.`,
          );
        }
        await resolver.ready;
        if (
          resolver.cancelled ||
          resolver.state !== 'pending' ||
          this.pendingDecisionResolvers.get(executionId) !== resolver
        ) {
          throw new AxlError(
            'PENDING_DECISION_NOT_FOUND',
            `The pending human decision for execution "${executionId}" is no longer active.`,
          );
        }
      } else if (!pending.some((request) => request.executionId === executionId)) {
        throw new AxlError(
          'PENDING_DECISION_NOT_FOUND',
          `No pending human decision exists for execution "${executionId}".`,
        );
      } else {
        throw new AxlError(
          'CROSS_PROCESS_RESUME_UNSUPPORTED',
          `Execution "${executionId}" is not awaiting a decision in this runtime. ` +
            'Cross-process approval replay requires a durable decision/lease lineage and is not yet supported; any persisted pending request was preserved.',
        );
      }
    }
    let finishResolution!: (succeeded: boolean) => void;
    const resolutionFinished = new Promise<boolean>((resolve) => {
      finishResolution = resolve;
    });
    resolver.state = 'resolving';
    resolver.resolution = resolutionFinished;
    // Keep the gate closed until durable request cleanup succeeds. If the
    // store rejects, the resolver and request remain retryable and no
    // post-approval workflow side effect can start.
    try {
      await this.stateStore.resolveDecision(executionId, decision);
      resolver.state = 'resolved';
      finishResolution(true);
      resolver.resolve(decision);
    } catch (error) {
      resolver.state = 'pending';
      finishResolution(false);
      throw error;
    }
  }

  /**
   * Summarize a list of chat messages into a concise summary string.
   * Used by Session to summarize dropped messages when history.summarize is enabled.
   * `previousSummary` is folded in so a rolling summary never loses what it
   * alone still carries. Shares its prompt and provider call with the
   * `AgentConfig.maxContext` summarizer (see `compaction.ts`). It runs outside
   * any workflow execution, so it emits no ask-scoped events.
   */
  async summarizeMessages(
    messages: ChatMessage[],
    modelUri: string,
    options?: { previousSummary?: string },
  ): Promise<string> {
    // Through the facade: a session-history summary is a real paid call and
    // belongs to whatever accounting scope is active, even though it runs
    // before any workflow execution id exists.
    const { provider, model } = this.resolveProvider(modelUri);
    const response = await requestSummary(provider, {
      model,
      prompt: buildSummaryPrompt(messages, options?.previousSummary),
    });
    return response.content;
  }

  /** Get the state store (for testing and advanced use cases). */
  getStateStore(): StateStore {
    return this.stateStore;
  }

  /**
   * Run an evaluation against a registered workflow.
   * Requires `axl-eval` as a peer dependency.
   *
   * @see Spec Section 13.5
   */
  async eval(
    config: RuntimeEvalConfigShape,
    options?: {
      onProgress?: (event: EvalProgressEventShape) => void;
      signal?: AbortSignal;
      captureTraces?: boolean;
      /** Forwarded to `runEval({ captureRequests })`. See
       *  {@link AxlRuntime.runRegisteredEval}. */
      captureRequests?:
        | boolean
        | { maxRecordBytes?: number; maxRunBytes?: number; maxQueueBytes?: number };
    },
  ): Promise<unknown> {
    let runEvalFn: (
      config: unknown,
      executeFn: (
        input: unknown,
        runtime: unknown,
      ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
      runtime: unknown,
      evalOptions?: {
        onProgress?: (event: EvalProgressEventShape) => void;
        signal?: AbortSignal;
        captureTraces?: boolean;
        captureRequests?: unknown;
      },
    ) => Promise<unknown>;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ runEval: runEvalFn } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.eval(). Install it with: npm install @axlsdk/eval',
      );
    }

    // No `trackExecution` wrapper: the runner opens the per-item accounting
    // scope, and `runtime.execute` inside it settles into that scope. Reporting
    // a `cost` here would make the runtime a CALLER of its own eval, and the
    // caller's number is never the measurement.
    const executeWorkflow = async (
      input: unknown,
    ): Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }> => {
      return { output: await this.execute(config.workflow, input) };
    };

    return runEvalFn(config, executeWorkflow, this, options);
  }

  /**
   * Compare two evaluation results to detect regressions and improvements.
   * Requires `axl-eval` as a peer dependency.
   *
   * @see Spec Section 13.6
   */
  async evalCompare(baseline: unknown, candidate: unknown, options?: unknown): Promise<unknown> {
    let evalCompareFn: (baseline: unknown, candidate: unknown, options?: unknown) => unknown;
    try {
      // @ts-expect-error — @axlsdk/eval is an optional peer dependency
      ({ evalCompare: evalCompareFn } = await import('@axlsdk/eval'));
    } catch {
      throw new Error(
        'axl-eval is required for AxlRuntime.evalCompare(). Install it with: npm install @axlsdk/eval',
      );
    }

    return evalCompareFn(baseline, candidate, options);
  }

  /**
   * Track cost across any runtime operations within the given function.
   * Uses AsyncLocalStorage to scope cost attribution to specific execution IDs,
   * making it correct with concurrent calls.
   *
   * Works with both `createContext()` and `execute()` calls inside `fn`.
   */
  async trackCost<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; cost: number; unpriced: boolean }> {
    const { result, cost, unpriced } = await this.trackExecution(fn);
    return { result, cost, unpriced };
  }

  /**
   * Run `fn` and ALWAYS return its outcome plus the authoritative
   * {@link Accounting} for everything paid that happened inside it.
   *
   * This is the accounting entry point. Unlike {@link trackExecution} it does
   * not throw on failure — a workflow that threw after a paid call still
   * returns that call's charge, which is what makes "what did the failed run
   * cost?" answerable. The thrown value is handed back verbatim in `error`:
   * primitives, frozen objects, `AbortError`, `ProviderError` and
   * `BudgetExceededError` all come back `===` what was thrown.
   *
   * Scopes nest. An operation settled inside a child `trackOutcome` is counted
   * exactly once in every enclosing scope, so a parent total is the sum of
   * disjoint operations. Concurrent `trackOutcome` calls on one runtime are
   * isolated: neither sees the other's operations, budget closure or spend.
   *
   * Pass `{ admission: new AdmissionController({ limit }) }` to stop admitting
   * new paid operations once known spend reaches the limit. Already-dispatched
   * work still settles and is still counted.
   *
   * Model metadata and timing share the settlement scope with accounting, so
   * they cross runtimes and compatible ESM/CJS copies. Workflow names and
   * captured traces still come from this runtime's events.
   */
  async trackOutcome<T>(
    fn: () => Promise<T>,
    options?: TrackOutcomeOptions,
  ): Promise<TrackedOutcome<T>> {
    const parentScope = costScopeStorage.getStore();
    const scope: CostScope = {
      totalCost: 0,
      trackedIds: new Set(),
      parent: parentScope,
    };

    // Insertion-ordered Map: first time we see a workflow it gets added at
    // the end, so iteration order is "first-seen first" — which for nested
    // workflow calls puts the outermost workflow first.
    const workflowCalls = new Map<string, number>();
    const capturedTraces: AxlEvent[] | undefined = options?.captureTraces ? [] : undefined;

    const listener = (event: AxlEvent) => {
      if (!scope.trackedIds.has(event.executionId)) return;
      // Cost rollup via shared helper — one source of truth for the
      // "skip ask_end, finite-check, leaf-only" invariant (spec §10). This
      // total feeds `trackCost`-era consumers of the TRACE rail only; the
      // authoritative figure is `accounting.knownCost`.
      scope.totalCost += eventCostContribution(event);
      // Both `runtime.execute()` and `runtime.stream()` now emit workflow_start
      // as a first-class `type: 'workflow_start'` event. AxlTestRuntime does
      // the same. The prior log-form fallback is no longer needed.
      if (event.type === 'workflow_start' && event.workflow) {
        workflowCalls.set(event.workflow, (workflowCalls.get(event.workflow) ?? 0) + 1);
      }

      // Capture a compact copy of the event when requested. We strip the
      // verbose `messages` field (can be tens of KB per turn) to keep memory
      // predictable — callers who need the full verbose snapshot should
      // subscribe to `runtime.on('trace', ...)` directly.
      if (capturedTraces) {
        // Skip high-volume stream-only events for the same reason
        // `runtime.execute()` / `runtime.stream()` drop them from
        // `ExecutionInfo.events` and Studio's WS replay buffer drops them
        // (`UNBUFFERED_EVENT_TYPES`): a streaming eval item with thousands
        // of tokens, progressive `partial_object` snapshots, or per-chunk
        // `string_delta` events would blow memory when `captureTraces:
        // true` is set on `runEval`. `string_delta` joined this list in
        // spec/17 — same rationale, same fix as the Studio replay-buffer
        // exclusion. Reviewer bug B3.
        if (
          event.type === 'token' ||
          event.type === 'partial_object' ||
          event.type === 'string_delta'
        ) {
          return;
        }
        // Verbose `messages[]` snapshots live on agent_call_start (request
        // side) under the start/end split. Strip to keep memory bounded.
        if (event.type === 'agent_call_start' && event.data) {
          const d = event.data as Record<string, unknown>;
          if ('messages' in d) {
            const rest: Record<string, unknown> = {};
            for (const k of Object.keys(d)) {
              if (k !== 'messages') rest[k] = d[k];
            }
            capturedTraces.push({ ...event, data: rest } as AxlEvent);
            return;
          }
        }
        capturedTraces.push(event);
      }
    };

    // Temporarily increase maxListeners to avoid warnings at high concurrency
    this.setMaxListeners(this.getMaxListeners() + 1);
    this.on('trace', listener);
    let outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown };
    let accounting: Accounting;
    let diagnostics: SettlementDiagnostics;
    try {
      // The accounting scope wraps the cost scope, so both are active for `fn`
      // and both are finalized on the same settlement — including the throwing
      // path, which is exactly where the old trace-only rail lost charges.
      ({ outcome, accounting, diagnostics } = await runInAccountingScope<T>(
        {
          purpose: options?.purpose,
          admission: options?.admission,
          captureTimingSamples: options?.captureTimingSamples,
        },
        () =>
          // Capture wraps the cost scope rather than the other way round so a
          // record can never be written for an operation the accounting scope
          // did not see. Both are pure ALS frames; omitting either is a no-op.
          runWithCaptureChannel(options?.capture, () =>
            runWithCaptureCorrelation(options?.captureCorrelation, () =>
              costScopeStorage.run(scope, fn),
            ),
          ),
      ));
    } finally {
      this.off('trace', listener);
      this.setMaxListeners(this.getMaxListeners() - 1);
    }

    if (outcome.status === 'rejected' && capturedTraces) {
      // Side channel for `trackExecution` callers, which only see the thrown
      // value. Best-effort: a frozen or non-object thrown value keeps its
      // identity rather than the attachment succeeding, because preserving the
      // error is the stronger contract.
      attachCapturedTraces(outcome.error, capturedTraces);
    }

    return {
      ...outcome,
      accounting,
      ...(Object.keys(diagnostics.modelTiming).length > 0
        ? { modelTiming: diagnostics.modelTiming }
        : {}),
      ...(capturedTraces ? { traces: capturedTraces } : {}),
      metadata: {
        models: Object.keys(diagnostics.modelCallCounts),
        modelCallCounts:
          Object.keys(diagnostics.modelCallCounts).length > 0
            ? diagnostics.modelCallCounts
            : undefined,
        tokens: diagnostics.tokens,
        agentCalls: diagnostics.agentCalls,
        workflows: [...workflowCalls.keys()],
        workflowCallCounts: workflowCalls.size > 0 ? Object.fromEntries(workflowCalls) : undefined,
      },
    };
  }

  /**
   * Throwing compatibility wrapper over {@link trackOutcome}.
   *
   * Returns the same shape it always has, now derived from the accounting rail
   * rather than summed from trace events: `cost` is `accounting.knownCost` and
   * `unpriced` is `accounting.completeness !== 'complete'`. For instrumented
   * paths the numbers are identical; they differ only where the trace rail used
   * to lose a charge (notably a leaf that never settled). `accounting` is
   * exposed alongside them so callers can migrate incrementally.
   *
   * On failure it rethrows the ORIGINAL error and, under `captureTraces`,
   * attaches the non-enumerable `axlCapturedTraces` side channel — prefer
   * {@link trackOutcome}, which returns the accounting for a failed run too.
   *
   * ## Cost vs tokens semantics
   *
   * - `cost` covers EVERY settled operation: agent calls, tool calls, semantic
   *   memory embeddings, transcriptions, declared external work. This is the
   *   number to reconcile against your provider bill.
   *
   * - `metadata.tokens` is narrowly scoped to **agent** prompt/completion/
   *   reasoning tokens. Embedder tokens from semantic `ctx.remember({embed:true})`
   *   / `ctx.recall({query})` are deliberately NOT summed here — they're a
   *   different category (input-only, different pricing, different model).
   *   Conflating them would make "prompt tokens" misleading in the UI. Read
   *   `accounting.usage` for the folded, category-separated totals.
   *
   * Pass `{ captureTraces: true }` to also collect the raw `AxlEvent[]` observed
   * during `fn()`. This is opt-in because it keeps every event in memory for the
   * duration of the call — useful for eval per-item capture, debugging, and test
   * assertions, but overhead grows with trace volume. When enabled, verbose-mode
   * `agent_call_start.data.messages` snapshots are omitted from captured events (still
   * broadcast via onTrace) to keep memory bounded — callers who need the full
   * verbose snapshot should subscribe to `runtime.on('trace', ...)` directly.
   *
   * Works with both `createContext()` and `execute()` calls inside `fn`.
   */
  async trackExecution<T>(
    fn: () => Promise<T>,
    options?: { captureTraces?: boolean; captureTimingSamples?: boolean },
  ): Promise<TrackExecutionResult<T>> {
    const outcome = await this.trackOutcome(fn, options);
    if (outcome.status === 'rejected') throw outcome.error;
    const { accounting, metadata, modelTiming, traces } = outcome;
    return {
      result: outcome.value,
      cost: accounting.knownCost,
      unpriced: accounting.completeness !== 'complete',
      accounting,
      metadata,
      ...(modelTiming ? { modelTiming } : {}),
      ...(traces ? { traces } : {}),
    };
  }

  /** Register an execution ID with the active cost scope for trackCost() attribution. */
  private registerWithCostScope(executionId: string): void {
    const costScope = costScopeStorage.getStore();
    if (costScope) {
      let scope: CostScope | undefined = costScope;
      while (scope) {
        scope.trackedIds.add(executionId);
        scope = scope.parent;
      }
    }
  }

  /**
   * Handle trace event output based on configuration.
   *
   * When trace is disabled or level is 'off', events are still emitted via
   * EventEmitter (for programmatic subscribers) but nothing is logged to console.
   * The emit('trace', event) call happens before this method is called, so
   * programmatic subscribers always receive events regardless of trace config.
   */
  private outputAxlEvent(event: AxlEvent): void {
    const traceConfig = this.config.trace;
    if (!traceConfig?.enabled) return;

    const level = traceConfig.level ?? 'steps';
    if (level === 'off') return;

    const output = traceConfig.output ?? 'console';

    if (output === 'json') {
      console.log(JSON.stringify(event));
      return;
    }

    if (output === 'file') {
      const filename = `axl-trace-${event.executionId}.jsonl`;
      try {
        appendFileSync(filename, JSON.stringify(event) + '\n');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          mkdirSync(dirname(filename), { recursive: true });
          appendFileSync(filename, JSON.stringify(event) + '\n');
        } else {
          throw err;
        }
      }
      return;
    }

    // Console output (default)
    this.logAxlEvent(event);
  }

  private logAxlEvent(event: AxlEvent): void {
    const level = this.config.trace?.level ?? 'steps';
    const workflowPrefix = event.workflow ? `workflow:${event.workflow} | ` : '';
    const parts = [`[axl] execution:${event.executionId}`];

    if (event.type === 'workflow_start') {
      // workflow name now lives on the event top-level, not in data.
      parts.push(`${workflowPrefix}started`);
    } else if (event.type === 'workflow_end') {
      // Honour the actual outcome — previously this always said "completed"
      // even for failed/aborted runs.
      const d = event.data as { status?: string; aborted?: boolean } | undefined;
      const status = d?.aborted ? 'aborted' : (d?.status ?? 'completed');
      parts.push(`${workflowPrefix}${status}`);
      if (event.duration != null) parts.push(`${(event.duration / 1000).toFixed(1)}s`);
    } else if (event.type === 'agent_call_end') {
      parts.push(`${workflowPrefix}step:${event.step} agent_call`);
      if (event.agent) parts.push(`agent:${event.agent}`);
      if (event.promptVersion) parts.push(`version:${event.promptVersion}`);
      if (event.model) parts.push(`model:${event.model}`);
      if (event.duration) parts.push(`${(event.duration / 1000).toFixed(1)}s`);
      if (event.cost) parts.push(`$${event.cost.toFixed(3)}`);
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
      }
    } else if (event.type === 'tool_call_end') {
      parts.push(`${workflowPrefix}step:${event.step} tool_call`);
      if (event.tool) parts.push(`tool:${event.tool}`);
      if (event.duration) parts.push(`${event.duration}ms`);
      if (level === 'full' && event.data) {
        parts.push(`data:${JSON.stringify(event.data)}`);
      }
    } else if (event.type === 'guardrail') {
      const gData = event.data as
        | { guardrailType?: string; blocked?: boolean; reason?: string }
        | undefined;
      parts.push(`${workflowPrefix}step:${event.step} guardrail`);
      if (gData?.guardrailType) parts.push(`type:${gData.guardrailType}`);
      if (gData?.blocked !== undefined) parts.push(gData.blocked ? 'BLOCKED' : 'passed');
      if (gData?.reason) parts.push(`reason:${gData.reason}`);
    } else if (event.type === 'log') {
      parts.push(`${workflowPrefix}log: ${JSON.stringify(event.data)}`);
    } else {
      parts.push(`${workflowPrefix}${event.type}`);
      // Some variants don't carry `data` (e.g., `ask_start`).
      // Inspect dynamically so the logger remains a catch-all without
      // enumerating every variant.
      const data = (event as { data?: unknown }).data;
      if (level === 'full' && data !== undefined) {
        parts.push(`data:${JSON.stringify(data)}`);
      }
    }

    console.log(parts.join(' | '));
  }

  /**
   * Append a handoff record to session metadata.
   * Note: The read-modify-write is not atomic. Concurrent handoffs in the same
   * session could lose a record. In practice, trace events within a single
   * execution are sequential (same event loop), so this is only a concern for
   * cross-execution concurrency on the same session, which is unlikely.
   */
  private appendHandoffRecord(sessionId: string, record: HandoffRecord): void {
    // Fire and forget — don't block the trace handler
    this.stateStore
      .getSessionMeta(sessionId, 'handoffHistory')
      .then((existing) => {
        const history = (existing as HandoffRecord[]) ?? [];
        history.push(record);
        return this.stateStore.saveSessionMeta(sessionId, 'handoffHistory', history);
      })
      .catch(() => {
        // Silently ignore persistence errors in the trace path
      });
  }

  /**
   * Patch `duration` on the handoff record matching `toAskId` (the target
   * frame's askId, which the runtime stamps on `handoff_start` and which
   * appears as `askId` on the target's `ask_end`).
   *
   * Called from two places per handoff:
   *   - target's `ask_end` — first-write source for ONEWAY (no return event).
   *   - `handoff_return`   — overwrites for ROUNDTRIP with the round-trip
   *                          wall-clock figure (intentional: round-trip
   *                          duration is the more useful metric for the
   *                          source-paused-for-N-ms semantic).
   *
   * No-op if no record matches `toAskId` (e.g., stream subscribed mid-
   * handoff, or session metadata got wiped) — `duration` stays undefined,
   * which is the documented default for `HandoffRecord`.
   */
  private updateHandoffDuration(
    sessionId: string,
    match: { toAskId: string; duration: number },
  ): void {
    this.stateStore
      .getSessionMeta(sessionId, 'handoffHistory')
      .then((existing) => {
        const history = (existing as HandoffRecord[]) ?? [];
        for (const r of history) {
          if (r.toAskId === match.toAskId) {
            r.duration = match.duration;
            return this.stateStore.saveSessionMeta(sessionId, 'handoffHistory', history);
          }
        }
        return undefined;
      })
      .catch(() => {
        // Silently ignore persistence errors in the trace path
      });
  }
}
