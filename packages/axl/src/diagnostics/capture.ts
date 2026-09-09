/**
 * Opt-in request capture — "what did we actually submit on the turn after the
 * model's output was rejected?"
 *
 * Capture is a **diagnostics** rail, strictly subordinate to the accounting
 * rail in `accounting.ts`. Nothing here may change what a run costs, whether it
 * succeeds, or how long a provider call takes:
 *
 * - Records are built at the scoped provider facade, by value, BEFORE the
 *   adapter can mutate the request. A caller mutating its own `messages` array
 *   afterwards cannot change what was recorded.
 * - Every sink write is fire-and-forget into a byte-bounded queue. A sink that
 *   blocks forever exhausts the queue and capture stops; the provider call is
 *   never awaited on it.
 * - Any failure — a throwing sink, an exhausted bound, an unserializable
 *   payload — degrades the manifest's `status`/`reason` and nothing else.
 *
 * Privacy is enforced by projection, not by filtering: only an allowlist of
 * request options is serialized, `providerOptions` contributes its KEYS only,
 * and rich media parts become bounded descriptors. Signals, functions and
 * credentials never enter a record in the first place. When redaction is
 * configured the projected record additionally passes through
 * `redactCapturedRequest()` before it reaches the sink.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { describeModelInput, type ModelInputDescriptor } from '../input.js';
import type {
  ChatMessage,
  ChatOptions,
  ResponseFormat,
  ToolDefinition,
} from '../providers/types.js';
import type { ProviderResponse, ToolCallMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Record shape (JSONL v1)
// ---------------------------------------------------------------------------

/** One conversation message as captured: text kept, rich media described. */
export type CapturedMessage = {
  role: string;
  /** Text content verbatim, or `null` when the message carried only rich parts. */
  content: string | null;
  /** Bounded descriptor for the non-text parts, when there were any. */
  input?: ModelInputDescriptor;
  name?: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
};

/** The provider-neutral request, snapshotted by value at invocation. */
export type CapturedRequest = {
  messages: CapturedMessage[];
  /** Tool definitions as the model sees them: names + JSON-Schema parameters. */
  tools?: Array<{ name: string; description?: string; parameters: unknown }>;
  responseFormat?: ResponseFormat;
  /** Allowlisted call options only. Never signals, functions or credentials. */
  options: {
    model: string;
    temperature?: number;
    maxTokens?: number;
    effort?: string;
    thinkingBudget?: number;
    includeThoughts?: boolean;
    toolChoice?: unknown;
    stop?: string[];
    promptCache?: boolean;
  };
  /** `providerOptions` KEYS only — the values can carry credentials. */
  providerOptionKeys?: string[];
};

/** What came back, projected to the fields that explain a turn. */
export type CapturedResponse = {
  content: string;
  tool_calls?: ToolCallMessage[];
  usage?: ProviderResponse['usage'];
  cost?: number;
  costProvenance?: string;
  timing?: ProviderResponse['timing'];
};

/** What went wrong, projected to identity rather than a serialized error. */
export type CapturedError = {
  name?: string;
  message: string;
  code?: string;
  status?: number;
};

/** The gate that rejected the previous turn and the correction fed back in. */
export type CapturedCorrection = {
  stage: 'schema' | 'validate' | 'guardrail';
  reason?: string;
  /** The exact text appended to the conversation for the next turn. */
  feedbackMessage: string;
};

/** Which part of an operation's life a record describes. */
export type CapturedPhase = 'start' | 'attempt' | 'end';

/**
 * One JSONL line. `v: 1` is the codec version; `@axlsdk/eval` re-exports this
 * as `RequestRecord` and owns the bundle/import validation around it.
 *
 * A `start` record carries the request; `attempt` records mark additional
 * transport attempts for the SAME logical operation (a 429 retry is not an
 * output repair); an `end` record carries the response or the error. An
 * operation that never returns therefore leaves a start record with no end —
 * which is exactly the call you most want to inspect.
 */
export type CapturedRequestRecord = {
  v: 1;
  phase: CapturedPhase;
  operationId: string;
  kind: 'chat' | 'stream';
  caseIndex?: number;
  scorer?: string;
  executionId?: string;
  askId?: string;
  parentAskId?: string;
  turn?: number;
  retryReason?: 'schema' | 'validate' | 'guardrail';
  /** 1-indexed transport attempt this record describes. */
  transportAttempts: number;
  provider: string;
  model: string;
  request?: CapturedRequest;
  response?: CapturedResponse;
  error?: CapturedError;
  /**
   * Why an operation ended without a response, when it ended deliberately.
   *
   * A stream closed by a stall timeout, a consumer `break`, or an adapter that
   * simply stopped yielding is NOT a call that never came back. Without this
   * the two are indistinguishable, and `start_only` — the status reserved for a
   * genuinely hung call — stops discriminating.
   */
  termination?: string;
  correction?: CapturedCorrection;
  captured: {
    fidelity: 'runtime_request';
    redacted: boolean;
    /** `true` when the record was replaced by a stub over `maxRecordBytes`. */
    truncated: boolean;
    /** What could not be represented, e.g. `['media']`. */
    omitted: string[];
  };
  /** Encoded size of the record this stub replaced. Present only on stubs. */
  bytes?: number;
};

/** A pointer from an eval item / scorer to one captured operation. */
export type CapturedOperationRef = {
  operationId: string;
  kind: 'chat' | 'stream';
  turn?: number;
  attempt?: number;
  status: 'recorded' | 'start_only' | 'truncated' | 'omitted';
};

// ---------------------------------------------------------------------------
// Sink and options
// ---------------------------------------------------------------------------

/** Where encoded record lines go. One call per JSONL line, already bounded. */
export type RequestCaptureSink = {
  append(line: string): Promise<void>;
};

/** Per-run capture bounds. All finite positive byte counts. */
export type RequestCaptureOptions = {
  sink: RequestCaptureSink;
  /** Encoded bytes above which a record is replaced by a stub. Default 256 KiB. */
  maxRecordBytes?: number;
  /** Encoded bytes above which capture stops for the run. Default 16 MiB. */
  maxRunBytes?: number;
  /** Pending unflushed bytes above which capture stops. Default 1 MiB. */
  maxQueueBytes?: number;
  /** Apply `redactCapturedRequest` before every write. */
  redact?: boolean;
  /** Bounded wait for the queue to drain at close. Default 5s. */
  flushTimeoutMs?: number;
  /**
   * Bytes the artifact this channel writes into ALREADY holds.
   *
   * A rescore opens its channel over an artifact seeded with its source run's
   * copied records. `maxRunBytes` is a promise about how large the artifact
   * gets, not about this channel's share of it, so the carried bytes count
   * against the same bound.
   */
  carriedBytes?: number;
};

/** Eval-side correlation stamped onto every record produced inside a scope. */
export type CaptureCorrelation = {
  caseIndex?: number;
  scorer?: string;
};

/** What a finished capture channel has to say about itself. */
export type RequestCaptureStatus = {
  status: 'complete' | 'truncated' | 'unavailable';
  reason?: string;
  records: number;
  bytes: number;
  redaction: 'applied' | 'none';
};

export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
export const DEFAULT_MAX_RUN_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Request projection
// ---------------------------------------------------------------------------

function captureMessage(message: ChatMessage): CapturedMessage {
  const out: CapturedMessage = { role: message.role, content: null };
  if (typeof message.content === 'string') {
    out.content = message.content;
  } else if (Array.isArray(message.content)) {
    // Rich parts: keep the text, describe everything else. `describeModelInput`
    // is the same bounded projection the trace rail uses, so media bytes have
    // exactly one representation in Axl and it is never the bytes themselves.
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
      .map((part) => part.text)
      .join('');
    out.content = text === '' ? null : text;
    const descriptor = describeModelInput(message.content);
    if (descriptor) out.input = descriptor;
  }
  if (message.name !== undefined) out.name = message.name;
  if (message.tool_calls) out.tool_calls = message.tool_calls.map((call) => ({ ...call }));
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  return out;
}

function hasRichParts(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part?.type !== 'text'),
  );
}

function captureTools(tools: ToolDefinition[] | undefined): CapturedRequest['tools'] {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
  }));
}

/**
 * Project a live request into a record payload, deep enough that later mutation
 * of the caller's arrays cannot reach it.
 *
 * The `options` allowlist is the privacy boundary: adding a field here is a
 * deliberate decision that it carries no credential and no user content.
 */
export function snapshotRequest(
  messages: readonly ChatMessage[],
  options: ChatOptions,
): { request: CapturedRequest; omitted: string[] } {
  const omitted: string[] = [];
  if (hasRichParts(messages)) omitted.push('media');
  const providerOptionKeys = options.providerOptions
    ? Object.keys(options.providerOptions)
    : undefined;
  if (providerOptionKeys && providerOptionKeys.length > 0) omitted.push('providerOptionValues');
  return {
    request: {
      messages: messages.map(captureMessage),
      ...(captureTools(options.tools) ? { tools: captureTools(options.tools) } : {}),
      ...(options.responseFormat
        ? { responseFormat: structuredClone(options.responseFormat) }
        : {}),
      options: {
        model: options.model,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        ...(options.thinkingBudget !== undefined ? { thinkingBudget: options.thinkingBudget } : {}),
        ...(options.includeThoughts !== undefined
          ? { includeThoughts: options.includeThoughts }
          : {}),
        ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(options.stop !== undefined ? { stop: [...options.stop] } : {}),
        ...(options.promptCache !== undefined ? { promptCache: options.promptCache } : {}),
      },
      ...(providerOptionKeys && providerOptionKeys.length > 0 ? { providerOptionKeys } : {}),
    },
    omitted,
  };
}

/** Project a provider response down to what explains the turn. */
export function snapshotResponse(response: ProviderResponse): CapturedResponse {
  return {
    content: response.content,
    ...(response.tool_calls ? { tool_calls: response.tool_calls.map((c) => ({ ...c })) } : {}),
    ...(response.usage ? { usage: { ...response.usage } } : {}),
    ...(response.cost !== undefined ? { cost: response.cost } : {}),
    ...(response.costProvenance !== undefined ? { costProvenance: response.costProvenance } : {}),
    ...(response.timing ? { timing: { ...response.timing } } : {}),
  };
}

/** Project a thrown value to its identity. Never serializes the error object. */
export function snapshotError(error: unknown): CapturedError {
  if (error instanceof Error) {
    const withFields = error as Error & { code?: unknown; status?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof withFields.code === 'string' ? { code: withFields.code } : {}),
      ...(typeof withFields.status === 'number' ? { status: withFields.status } : {}),
    };
  }
  return { message: String(error) };
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/**
 * The bounded, non-blocking pipeline between the facade and a sink.
 *
 * One channel per capturing run. It owns the run's byte budget, the pending
 * queue, and the ledger of which operations produced which records — the
 * ledger is what lets an eval item point at its own operations without the
 * runner having to parse the JSONL back.
 */
export class RequestCaptureChannel {
  private readonly sink: RequestCaptureSink;
  private readonly maxRecordBytes: number;
  private readonly maxRunBytes: number;
  private readonly maxQueueBytes: number;
  private readonly flushTimeoutMs: number;
  readonly redact: boolean;

  private runBytes: number;
  private queueBytes = 0;
  private records = 0;
  private stopped = false;
  private status: RequestCaptureStatus['status'] = 'complete';
  private reason: string | undefined;
  private drain: Promise<void> = Promise.resolve();
  private stoppedSignal: (() => void) | undefined;
  private readonly stoppedPromise: Promise<void>;

  /** operationId → the ref an eval item/scorer will point at. */
  private readonly refs = new Map<
    string,
    CapturedOperationRef & { caseIndex?: number; scorer?: string }
  >();

  constructor(options: RequestCaptureOptions) {
    this.sink = options.sink;
    this.maxRecordBytes = positive(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES);
    this.maxRunBytes = positive(options.maxRunBytes, DEFAULT_MAX_RUN_BYTES);
    this.maxQueueBytes = positive(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES);
    this.flushTimeoutMs = positive(options.flushTimeoutMs, DEFAULT_FLUSH_TIMEOUT_MS);
    this.redact = options.redact === true;
    // Bytes already in the artifact count against the SAME run bound: the bound
    // is a promise about how large the artifact gets, and a rescore that copied
    // its source in must not then be allowed a second full budget of its own.
    this.runBytes = Math.max(0, options.carriedBytes ?? 0);
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stoppedSignal = resolve;
    });
  }

  /**
   * Report a capture-side failure from outside the channel.
   *
   * The producers on the provider path (request projection, redaction, record
   * assembly) can throw on inputs that are perfectly legal for a provider call
   * — a `json_schema.schema` holding a function, a content part whose `type` no
   * adapter recognizes. None of that may fail the call, so those sites catch
   * and report here: capture stops and says why, and nothing else changes.
   */
  fail(reason: string): void {
    this.stop('unavailable', reason);
  }

  /** Stop capturing for the rest of the run and remember why. */
  private stop(status: 'truncated' | 'unavailable', reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.status = status;
    this.reason = reason;
    this.stoppedSignal?.();
  }

  /**
   * Enqueue one record. Synchronous and total: it returns immediately whatever
   * the sink is doing, and it never throws into the provider call path.
   */
  write(record: CapturedRequestRecord): void {
    if (this.stopped) return;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (error) {
      // An unserializable payload is a capture defect, not a run defect.
      this.stop('unavailable', `record could not be encoded: ${describe(error)}`);
      return;
    }
    let bytes = Buffer.byteLength(line, 'utf-8');
    if (bytes > this.maxRecordBytes) {
      const stub: CapturedRequestRecord = {
        v: 1,
        phase: record.phase,
        operationId: record.operationId,
        kind: record.kind,
        ...(record.caseIndex !== undefined ? { caseIndex: record.caseIndex } : {}),
        ...(record.scorer !== undefined ? { scorer: record.scorer } : {}),
        ...(record.turn !== undefined ? { turn: record.turn } : {}),
        transportAttempts: record.transportAttempts,
        provider: record.provider,
        model: record.model,
        captured: {
          fidelity: 'runtime_request',
          redacted: record.captured.redacted,
          truncated: true,
          omitted: ['record'],
        },
        bytes,
      };
      line = JSON.stringify(stub);
      bytes = Buffer.byteLength(line, 'utf-8');
      const existing = this.refs.get(record.operationId);
      if (existing) existing.status = 'truncated';
    }
    if (this.runBytes + bytes > this.maxRunBytes) {
      this.stop(
        'truncated',
        `run capture limit of ${this.maxRunBytes} bytes reached; later records were dropped`,
      );
      return;
    }
    if (this.queueBytes + bytes > this.maxQueueBytes) {
      this.stop(
        'truncated',
        `pending capture queue of ${this.maxQueueBytes} bytes was exhausted by a slow sink; later records were dropped`,
      );
      return;
    }
    this.runBytes += bytes;
    this.queueBytes += bytes;
    this.records += 1;
    // Fire-and-forget: the provider call never awaits this chain.
    this.drain = this.drain.then(async () => {
      try {
        await this.sink.append(line);
      } catch (error) {
        this.stop('unavailable', `diagnostic sink failed: ${describe(error)}`);
      } finally {
        this.queueBytes -= bytes;
      }
    });
  }

  /** Register (or upgrade) the ref an eval item will point at. */
  noteOperation(ref: CapturedOperationRef & { caseIndex?: number; scorer?: string }): void {
    const existing = this.refs.get(ref.operationId);
    if (!existing) {
      this.refs.set(ref.operationId, { ...ref });
      return;
    }
    // A truncation verdict is sticky: a later `recorded` must not erase it.
    if (existing.status !== 'truncated') existing.status = ref.status;
    if (ref.attempt !== undefined) existing.attempt = ref.attempt;
    if (ref.turn !== undefined && existing.turn === undefined) existing.turn = ref.turn;
  }

  /** Every operation this run captured, with the correlation it was seen under. */
  operations(): Array<CapturedOperationRef & { caseIndex?: number; scorer?: string }> {
    return [...this.refs.values()].map((ref) => ({ ...ref }));
  }

  /**
   * Wait for the queue to drain (bounded) and report the run's capture status.
   *
   * Called after the tracked function has already returned, so it can never
   * delay a provider call. It is additionally bounded three ways: a stopped
   * channel abandons its queue immediately, the queue itself is byte-bounded,
   * and a flush timeout is the final backstop against a sink that never
   * settles.
   */
  async close(): Promise<RequestCaptureStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.stop('truncated', `diagnostic sink did not drain within ${this.flushTimeoutMs}ms`);
        resolve();
      }, this.flushTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([this.drain, this.stoppedPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.stopped = true;
    return {
      status: this.status,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      records: this.records,
      bytes: this.runBytes,
      redaction: this.redact ? 'applied' : 'none',
    };
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Ambient plumbing
// ---------------------------------------------------------------------------

const channelStorage = new AsyncLocalStorage<RequestCaptureChannel>();
const correlationStorage = new AsyncLocalStorage<CaptureCorrelation>();

/** @internal The capture channel for the active `trackOutcome` scope, if any. */
export function currentCaptureChannel(): RequestCaptureChannel | undefined {
  return channelStorage.getStore();
}

/** @internal The eval-side correlation stamped on records built here. */
export function currentCaptureCorrelation(): CaptureCorrelation | undefined {
  return correlationStorage.getStore();
}

/** @internal Run `fn` with `channel` as the ambient capture destination. */
export function runWithCaptureChannel<T>(
  channel: RequestCaptureChannel | undefined,
  fn: () => T,
): T {
  if (!channel) return fn();
  return channelStorage.run(channel, fn);
}

/**
 * @internal Run `fn` with `correlation` merged over the enclosing one, so a
 * scorer scope nested inside an item scope keeps the item's `caseIndex`.
 */
export function runWithCaptureCorrelation<T>(
  correlation: CaptureCorrelation | undefined,
  fn: () => T,
): T {
  if (!correlation) return fn();
  const merged = { ...correlationStorage.getStore(), ...correlation };
  return correlationStorage.run(merged, fn);
}

// ---------------------------------------------------------------------------
// Turn-level correlation (set by WorkflowContext around each provider turn)
// ---------------------------------------------------------------------------

/** Per-turn identity the context knows and the facade does not. */
export type CaptureTurnContext = {
  executionId?: string;
  askId?: string;
  parentAskId?: string;
  turn?: number;
  retryReason?: 'schema' | 'validate' | 'guardrail';
  correction?: CapturedCorrection;
};

/**
 * A MUTABLE holder rather than a value, because one ask spans many turns and
 * the provider call for turn N+1 happens deep inside the same `askStorage.run`
 * frame as turn 1. The ask establishes the holder once; each turn overwrites
 * its contents immediately before dispatch. `AsyncLocalStorage` still gives
 * concurrent asks their own holders, so a nested or parallel ask cannot stamp
 * its turn index onto its sibling's records.
 */
type TurnSlot = { current: CaptureTurnContext };

const turnStorage = new AsyncLocalStorage<TurnSlot>();

/** @internal Turn identity for the provider call running on this async context. */
export function currentCaptureTurn(): CaptureTurnContext | undefined {
  return turnStorage.getStore()?.current;
}

/** @internal Open a per-ask turn slot. Cheap no-op when nothing is capturing. */
export function runWithCaptureTurnSlot<T>(fn: () => T): T {
  return turnStorage.run({ current: {} }, fn);
}

/** @internal Overwrite the enclosing ask's turn identity before a dispatch. */
export function setCaptureTurn(turn: CaptureTurnContext): void {
  const slot = turnStorage.getStore();
  if (slot) slot.current = turn;
}
