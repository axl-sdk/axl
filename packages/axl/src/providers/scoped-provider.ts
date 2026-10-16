/**
 * The scoped provider facade — the single invocation boundary where a paid
 * model call meets accounting and admission.
 *
 * `runtime.resolveProvider()` returns this facade rather than the registered
 * adapter instance. Everything that reaches a provider through the runtime —
 * `ctx.ask`, context-management summarization, `runtime.summarizeMessages`, and
 * eval scorers resolving through `ScorerContext.resolveProvider` — therefore
 * shares one settlement producer. Adapters stay unmodified and unwrapped in the
 * registry; nothing is cached per run, and the ACTIVE accounting scope is read
 * at each invocation (and, for `stream`, at the first `next()`), so one facade
 * instance serves any number of concurrent scopes correctly.
 *
 * **Breaking (documented)**: `resolveProvider(uri).provider === registeredInstance`
 * is now `false`. Everything else about the adapter is forwarded: custom
 * properties and accessors evaluate on the raw instance (so class private
 * fields work), non-intercepted methods are bound to it, property writes reach
 * it, and ordinary `instanceof` still holds. Exotic reflection — a custom
 * `Symbol.hasInstance`, identity-keyed maps — is not guaranteed.
 *
 * Outside an accounting scope the facade still delegates provider work; when
 * runtime telemetry is enabled it also observes dispatched calls as spans.
 */

import { openOperation, type AccountingUsage, type OperationHandle } from '../accounting.js';
import {
  currentCaptureChannel,
  currentCaptureCorrelation,
  currentCaptureTurn,
  setCaptureCallId,
  snapshotError,
  snapshotRequest,
  snapshotResponse,
  type CapturedModelRequestRecord,
  type CapturedRequestRecord,
  type RequestCaptureChannel,
} from '../diagnostics/capture.js';
import { redactCapturedRequest } from '../redaction.js';
import type { CallTiming, ProviderResponse } from '../types.js';
import { StallTimeoutError } from '../errors.js';
import { GenAiStreamContent, genAiInferenceEnd, genAiInferenceStart } from '../telemetry/gen-ai.js';
import type { SpanHandle, SpanManager } from '../telemetry/types.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from './types.js';

/** Map a provider usage block onto the accounting usage buckets. */
function toAccountingUsage(
  usage: ProviderResponse['usage'] | undefined,
): Partial<AccountingUsage> | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.reasoning_tokens ?? 0,
    cachedTokens: usage.cached_tokens ?? 0,
    cacheWriteTokens: usage.cache_write_tokens ?? 0,
  };
}

/** Optional diagnostics must never turn a settled response into a failure. */
function safeTiming(response: { timing?: CallTiming }): CallTiming | undefined {
  try {
    const timing = response.timing;
    if (!timing) return undefined;
    // Snapshot the fields before settlement. A custom provider may supply a
    // getter or proxy whose later read throws; diagnostics cannot interrupt a
    // successful accounting/admission settlement.
    const queuedMs = timing.queuedMs;
    const retryMs = timing.retryMs;
    const wireMs = timing.wireMs;
    if (![queuedMs, retryMs, wireMs].every((value) => Number.isFinite(value) && value >= 0)) {
      return undefined;
    }
    const attempts = timing.attempts;
    const ttfbMs = timing.ttfbMs;
    const rateLimitRetries = timing.rateLimitRetries;
    const firstTokenMs = timing.firstTokenMs;
    const valid = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    return {
      queuedMs,
      retryMs,
      wireMs,
      ...(valid(attempts) ? { attempts } : {}),
      ...(valid(ttfbMs) ? { ttfbMs } : {}),
      ...(valid(rateLimitRetries) ? { rateLimitRetries } : {}),
      ...(valid(firstTokenMs) ? { firstTokenMs } : {}),
    } as CallTiming;
  } catch {
    return undefined;
  }
}

/**
 * Chain the caller's `requestLifecycle` with the runtime's own dispatch
 * observation. The caller's callbacks still fire, unchanged and first.
 */
function composeLifecycle(
  caller: ChatOptions['requestLifecycle'],
  onDispatch: () => void,
): NonNullable<ChatOptions['requestLifecycle']> {
  return {
    onDispatch(): void {
      caller?.onDispatch?.();
      onDispatch();
    },
    onRetry(): void {
      caller?.onRetry?.();
    },
  };
}

function instrumentedOptions(
  options: ChatOptions,
  handle?: OperationHandle,
  recorder?: CaptureRecorder,
  onDispatch?: () => void,
): ChatOptions {
  if (!handle && !onDispatch) return options;
  return {
    ...options,
    requestLifecycle: composeLifecycle(options.requestLifecycle, () => {
      handle?.markDispatched();
      recorder?.markDispatch();
      onDispatch?.();
    }),
    dispatchAdmission: handle?.dispatchAdmission ?? options.dispatchAdmission,
  };
}

/**
 * The capture side of one provider invocation.
 *
 * Created BEFORE the adapter is called, so `snapshotRequest` runs against the
 * request as the runtime built it — after the adapter has had a chance to
 * mutate the arrays, and after the caller has had a chance to mutate its own,
 * the record would describe something that was never submitted.
 *
 * Returns `undefined` when nothing is capturing, which is the default and
 * costs one `AsyncLocalStorage` read.
 */
function beginCapture(
  raw: Provider,
  kind: 'chat' | 'stream',
  operationId: string,
  messages: readonly ChatMessage[],
  options: ChatOptions,
): CaptureRecorder | undefined {
  const channel = currentCaptureChannel();
  if (!channel) return undefined;
  try {
    return new CaptureRecorder(
      channel,
      raw.name ?? 'unknown',
      kind,
      operationId,
      messages,
      options,
    );
  } catch (error) {
    // This sits between an OPENED accounting operation and the provider call.
    // A throw here would fail a call that was about to succeed and leave the
    // operation to be finalized as `abandoned` — the one outcome the
    // "identical with capture on or off" guarantee forbids. The projection
    // inputs are not ours to validate: `json_schema.schema` is typed `unknown`,
    // and a message rehydrated from an older session may carry a content part
    // no current adapter names.
    //
    // An unexpected recorder failure must not fail provider work. In
    // particular, no record can be written here: a built-in adapter may still
    // be refused at its dispatch admission check.
    void error;
    return undefined;
  }
}

/** The identity a stub keeps when its content could not be projected. */
type StubIdentity = {
  operationId: string;
  kind: 'chat' | 'stream';
  provider: string;
  model: string;
  transportAttempts: number;
  caseIndex?: number;
  scorer?: string;
  executionId?: string;
  workflow?: string;
  agent?: string;
  depth?: number;
  sessionId?: string;
  purpose?: CapturedRequestRecord['purpose'];
  askId?: string;
  parentAskId?: string;
  turn?: number;
  retryReason?: CapturedRequestRecord['retryReason'];
  rejectedCallId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  outcomeStatus?: CapturedRequestRecord['outcomeStatus'];
};

/**
 * Record that one operation could not be projected, and say so in the artifact.
 *
 * Deliberately built from literals only: this runs on a path that has already
 * failed once, and it must not be able to fail again. The operation is marked
 * `omitted` rather than dropped — an operation missing from the artifact reads
 * as a call that was never made.
 */
function stubRecord(
  channel: RequestCaptureChannel,
  identity: StubIdentity,
  phase: CapturedRequestRecord['phase'],
  reason: string,
): void {
  channel.write({
    v: 1,
    phase,
    operationId: identity.operationId,
    kind: identity.kind,
    transportAttempts: identity.transportAttempts,
    provider: identity.provider,
    model: identity.model,
    ...(identity.caseIndex !== undefined ? { caseIndex: identity.caseIndex } : {}),
    ...(identity.scorer !== undefined ? { scorer: identity.scorer } : {}),
    ...(identity.executionId !== undefined ? { executionId: identity.executionId } : {}),
    ...(identity.workflow !== undefined ? { workflow: identity.workflow } : {}),
    ...(identity.agent !== undefined ? { agent: identity.agent } : {}),
    ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    ...(identity.purpose !== undefined ? { purpose: identity.purpose } : {}),
    ...(identity.askId !== undefined ? { askId: identity.askId } : {}),
    ...(identity.parentAskId !== undefined ? { parentAskId: identity.parentAskId } : {}),
    ...(identity.turn !== undefined ? { turn: identity.turn } : {}),
    ...(identity.retryReason !== undefined ? { retryReason: identity.retryReason } : {}),
    ...(identity.rejectedCallId !== undefined ? { rejectedCallId: identity.rejectedCallId } : {}),
    ...(identity.startedAt !== undefined ? { startedAt: identity.startedAt } : {}),
    ...(identity.endedAt !== undefined ? { endedAt: identity.endedAt } : {}),
    ...(identity.durationMs !== undefined ? { durationMs: identity.durationMs } : {}),
    ...(identity.outcomeStatus !== undefined ? { outcomeStatus: identity.outcomeStatus } : {}),
    captured: {
      fidelity: 'runtime_request',
      redacted: channel.redact,
      truncated: true,
      omitted: ['record'],
      reason,
    },
  });
  channel.noteOperation({
    operationId: identity.operationId,
    kind: identity.kind,
    status: 'omitted',
  });
}

/**
 * A capture-side failure reason from a fixed set of labels, never error data.
 *
 * The reason lands in `captured.reason` on a stub, and a stub is written
 * straight to the channel rather than through `redactCapturedRequest` — it has
 * no request or response to scrub. That is only safe while the reason cannot
 * carry content: a `DataCloneError` stringifies the value it choked on, and an
 * adapter that throws from a response getter can put model output in the
 * message, which under `trace.redact` would land in the artifact labelled
 * scrubbed. Custom names, codes and toStringTag values can also contain
 * request data, and even inspecting a thrown value can throw again.
 */
function describeCaptureFailure(error: unknown): string {
  try {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      if (error.name === 'DataCloneError') return 'DataCloneError';
      return 'DOMException';
    }
    if (error instanceof Error) return 'Error';
  } catch {
    return 'capture failure';
  }
  return 'capture failure';
}

class CaptureRecorder {
  private attempts = 0;
  private ended = false;
  private startedAtMs: number | undefined;
  private readonly turn: ReturnType<typeof currentCaptureTurn>;
  private readonly liveTurn: ReturnType<typeof currentCaptureTurn>;
  private readonly correlation: ReturnType<typeof currentCaptureCorrelation>;
  private readonly omitted: string[];
  private readonly request: ReturnType<typeof snapshotRequest>['request'] | undefined;
  private readonly projectionFailure: string | undefined;
  private readonly model: string;
  private readonly signal: AbortSignal | undefined;
  private readonly textDeltas: string[] = [];
  private readonly thinkingDeltas: string[] = [];
  private readonly toolCallDeltas = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();

  private stubIdentity(outcomeStatus?: CapturedRequestRecord['outcomeStatus']): StubIdentity {
    const endedAtMs = outcomeStatus !== undefined ? Date.now() : undefined;
    return {
      operationId: this.operationId,
      kind: this.kind,
      provider: this.provider,
      model: this.model,
      transportAttempts: Math.max(1, this.attempts),
      ...(this.correlation?.caseIndex !== undefined
        ? { caseIndex: this.correlation.caseIndex }
        : {}),
      ...(this.correlation?.scorer !== undefined ? { scorer: this.correlation.scorer } : {}),
      ...(this.turn?.executionId !== undefined ? { executionId: this.turn.executionId } : {}),
      ...(this.turn?.workflow !== undefined ? { workflow: this.turn.workflow } : {}),
      ...(this.turn?.agent !== undefined ? { agent: this.turn.agent } : {}),
      ...(this.turn?.depth !== undefined ? { depth: this.turn.depth } : {}),
      ...(this.turn?.sessionId !== undefined ? { sessionId: this.turn.sessionId } : {}),
      purpose: this.correlation?.scorer ? 'judge' : (this.turn?.purpose ?? 'direct'),
      ...(this.turn?.askId !== undefined ? { askId: this.turn.askId } : {}),
      ...(this.turn?.parentAskId !== undefined ? { parentAskId: this.turn.parentAskId } : {}),
      ...(this.turn?.turn !== undefined ? { turn: this.turn.turn } : {}),
      ...(this.turn?.retryReason !== undefined ? { retryReason: this.turn.retryReason } : {}),
      ...(this.turn?.rejectedCallId !== undefined
        ? { rejectedCallId: this.turn.rejectedCallId }
        : {}),
      ...(this.startedAtMs !== undefined
        ? { startedAt: new Date(this.startedAtMs).toISOString() }
        : {}),
      ...(endedAtMs !== undefined ? { endedAt: new Date(endedAtMs).toISOString() } : {}),
      ...(endedAtMs !== undefined && this.startedAtMs !== undefined
        ? { durationMs: Math.max(0, endedAtMs - this.startedAtMs) }
        : {}),
      ...(outcomeStatus !== undefined ? { outcomeStatus } : {}),
    };
  }

  constructor(
    private readonly channel: RequestCaptureChannel,
    private readonly provider: string,
    private readonly kind: 'chat' | 'stream',
    private readonly operationId: string,
    messages: readonly ChatMessage[],
    options: ChatOptions,
  ) {
    const ambientTurn = currentCaptureTurn();
    // A direct provider call inside a tool still runs under the surrounding
    // ask's ALS frame. Only ctx.ask's marked request or an explicit summary
    // call belongs to that turn; all other facade calls are direct.
    const turn =
      options.accountingModelUri !== undefined || ambientTurn?.purpose === 'summary'
        ? ambientTurn
        : undefined;
    const correlation = currentCaptureCorrelation();
    this.liveTurn = turn;
    this.turn = turn ? { ...turn } : undefined;
    this.correlation = correlation ? { ...correlation } : undefined;
    this.model = options.model;
    this.signal = options.signal;
    try {
      const snapshot = snapshotRequest(messages, options);
      this.request = snapshot.request;
      this.omitted = snapshot.omitted;
    } catch (error) {
      this.omitted = ['record'];
      this.projectionFailure = `the request could not be captured: ${describeCaptureFailure(error)}`;
    }
  }

  private emit(
    partial: Pick<CapturedModelRequestRecord, 'phase' | 'transportAttempts'> &
      Partial<CapturedModelRequestRecord>,
  ): void {
    const record: CapturedModelRequestRecord = {
      v: 1,
      operationId: this.operationId,
      kind: this.kind,
      provider: this.provider,
      model: this.model,
      ...(this.correlation?.caseIndex !== undefined
        ? { caseIndex: this.correlation.caseIndex }
        : {}),
      ...(this.correlation?.scorer !== undefined ? { scorer: this.correlation.scorer } : {}),
      ...(this.turn?.executionId !== undefined ? { executionId: this.turn.executionId } : {}),
      ...(this.turn?.workflow !== undefined ? { workflow: this.turn.workflow } : {}),
      ...(this.turn?.agent !== undefined ? { agent: this.turn.agent } : {}),
      ...(this.turn?.depth !== undefined ? { depth: this.turn.depth } : {}),
      ...(this.turn?.sessionId !== undefined ? { sessionId: this.turn.sessionId } : {}),
      purpose: this.correlation?.scorer ? 'judge' : (this.turn?.purpose ?? 'direct'),
      ...(this.turn?.askId !== undefined ? { askId: this.turn.askId } : {}),
      ...(this.turn?.parentAskId !== undefined ? { parentAskId: this.turn.parentAskId } : {}),
      ...(this.turn?.turn !== undefined ? { turn: this.turn.turn } : {}),
      ...(this.turn?.retryReason !== undefined ? { retryReason: this.turn.retryReason } : {}),
      ...(this.turn?.rejectedCallId !== undefined
        ? { rejectedCallId: this.turn.rejectedCallId }
        : {}),
      ...(this.turn?.correction !== undefined ? { correction: this.turn.correction } : {}),
      captured: {
        fidelity: 'runtime_request',
        redacted: false,
        truncated: false,
        omitted: this.omitted,
      },
      ...partial,
    };
    this.channel.write(this.channel.redact ? redactCapturedRequest(record) : record);
  }

  /**
   * Run one capture step, absorbing any failure into the channel.
   *
   * Every public entry point on this class is called from inside the provider
   * call path — one of them from inside an adapter's own retry loop — so none
   * of them may throw. `RequestCaptureChannel.write()` is already total for the
   * same reason; this extends that discipline to the producers.
   */
  private guarded(
    what: string,
    phase: CapturedRequestRecord['phase'],
    step: () => void,
    outcomeStatus?: CapturedRequestRecord['outcomeStatus'],
  ): void {
    try {
      step();
    } catch (error) {
      // One record degrades; the run's capture continues. `fail()` is reserved
      // for a channel-wide failure (a dead sink), which is what §12.3's
      // `unavailable` means — a projection failure on one call is the
      // truncation case, and saying otherwise throws away every later record.
      //
      // `ended` is deliberately NOT set here. A retry record that failed to
      // project says nothing about the response that follows: the call is still
      // running and still returns normally, so suppressing its `end` would drop
      // a record capture could perfectly well have written. Only `end()` seals
      // the operation, and it sets the flag itself.
      stubRecord(
        this.channel,
        this.stubIdentity(outcomeStatus),
        phase,
        `${what} could not be captured: ${describeCaptureFailure(error)}`,
      );
    }
  }

  /** A transport attempt beyond the first: the SAME operation, retried. */
  markDispatch(): void {
    this.attempts += 1;
    if (this.attempts === 1) {
      const startedAtMs = Date.now();
      this.startedAtMs = startedAtMs;
      if (this.turn) setCaptureCallId(this.operationId);
      this.guarded('a request', 'start', () => {
        // Register the full eval correlation before either write path. An
        // oversized write and an unprojectable request both update this ref
        // to a sticky loss verdict; registering afterwards would overwrite
        // the verdict, while returning early from a projection stub would
        // leave its case/scorer identity absent from eval diagnostics.
        this.channel.noteOperation({
          operationId: this.operationId,
          kind: this.kind,
          ...(this.turn?.turn !== undefined ? { turn: this.turn.turn } : {}),
          status: 'start_only',
          ...(this.correlation?.caseIndex !== undefined
            ? { caseIndex: this.correlation.caseIndex }
            : {}),
          ...(this.correlation?.scorer !== undefined ? { scorer: this.correlation.scorer } : {}),
        });
        if (this.projectionFailure) {
          stubRecord(this.channel, this.stubIdentity(), 'start', this.projectionFailure);
          return;
        }
        this.emit({
          phase: 'start',
          transportAttempts: 1,
          startedAt: new Date(startedAtMs).toISOString(),
          ...(this.request ? { request: this.request } : {}),
          captured: {
            fidelity: 'runtime_request',
            redacted: false,
            truncated: false,
            continuityCaptured: true,
            omitted: this.omitted,
          },
        });
      });
      return;
    }
    this.guarded('a transport attempt', 'attempt', () => {
      this.emit({ phase: 'attempt', transportAttempts: this.attempts });
      this.channel.noteOperation({
        operationId: this.operationId,
        kind: this.kind,
        attempt: this.attempts,
        status: 'start_only',
      });
    });
  }

  /** Accumulate only while capture is active; the ordinary stream allocates nothing here. */
  observeChunk(chunk: StreamChunk): void {
    if (this.attempts === 0 || this.ended) return;
    try {
      if (chunk.type === 'text_delta') this.textDeltas.push(chunk.content);
      else if (chunk.type === 'thinking_delta') this.thinkingDeltas.push(chunk.content);
      else if (chunk.type === 'tool_call_delta') {
        const current = this.toolCallDeltas.get(chunk.id) ?? {
          id: chunk.id,
          name: '',
          arguments: '',
        };
        if (chunk.name) current.name = chunk.name;
        if (chunk.arguments) current.arguments += chunk.arguments;
        this.toolCallDeltas.set(chunk.id, current);
      }
    } catch {
      // A custom adapter can expose a throwing chunk getter. The returned
      // chunk remains the adapter's; mark the journal incomplete instead of
      // changing the model call's result.
      if (!this.omitted.includes('streamChunk')) this.omitted.push('streamChunk');
    }
  }

  private observedToolCalls(): ProviderResponse['tool_calls'] {
    return this.toolCallDeltas.size
      ? [...this.toolCallDeltas.values()].map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        }))
      : undefined;
  }

  endStream(chunk: Extract<StreamChunk, { type: 'done' }>): void {
    try {
      const toolCalls = this.observedToolCalls();
      this.end({
        response: {
          content: this.textDeltas.join(''),
          ...(this.thinkingDeltas.length ? { thinking_content: this.thinkingDeltas.join('') } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
          ...(chunk.usage ? { usage: chunk.usage } : {}),
          ...(chunk.cost !== undefined ? { cost: chunk.cost } : {}),
          ...(chunk.costProvenance !== undefined ? { costProvenance: chunk.costProvenance } : {}),
          ...(chunk.providerMetadata !== undefined
            ? { providerMetadata: chunk.providerMetadata }
            : {}),
          ...(chunk.finishReason !== undefined ? { finishReason: chunk.finishReason } : {}),
          ...(chunk.rawFinishReason !== undefined
            ? { rawFinishReason: chunk.rawFinishReason }
            : {}),
          ...(chunk.responseId !== undefined ? { responseId: chunk.responseId } : {}),
          ...(chunk.responseModel !== undefined ? { responseModel: chunk.responseModel } : {}),
          ...(chunk.timing !== undefined ? { timing: chunk.timing } : {}),
        },
      });
    } catch (error) {
      // A terminal chunk whose getter throws cannot be projected safely. It
      // still settled successfully on the provider path, so retain that fact.
      this.ended = true;
      stubRecord(
        this.channel,
        this.stubIdentity('ok'),
        'end',
        `a response could not be captured: ${describeCaptureFailure(error)}`,
      );
    }
  }

  /** Context's first-wins stamp outranks the fallback; a signal is next. */
  termination(fallback: string | undefined, error?: unknown): string | undefined {
    if (this.liveTurn?.terminationCause) return this.liveTurn.terminationCause;
    if (this.signal?.aborted) {
      const reason = this.signal.reason;
      return reason instanceof Error && reason.name === 'StallTimeout' ? 'stalled' : 'aborted';
    }
    if (error instanceof StallTimeoutError) return 'stalled';
    if (error instanceof Error && error.name === 'AbortError') return 'aborted';
    return fallback;
  }

  end(outcome: { response?: ProviderResponse; error?: unknown; termination?: string }): void {
    if (this.ended || this.attempts === 0) return;
    this.ended = true;
    this.guarded(
      'a response',
      'end',
      () => {
        const endedAtMs = Date.now();
        const errorTiming =
          'error' in outcome ? safeTiming(outcome.error as { timing?: CallTiming }) : undefined;
        this.emit({
          phase: 'end',
          transportAttempts: Math.max(1, this.attempts),
          endedAt: new Date(endedAtMs).toISOString(),
          ...(this.startedAtMs !== undefined
            ? { durationMs: Math.max(0, endedAtMs - this.startedAtMs) }
            : {}),
          ...(outcome.response ? { response: snapshotResponse(outcome.response) } : {}),
          ...(!outcome.response &&
          (this.textDeltas.length || this.thinkingDeltas.length || this.toolCallDeltas.size)
            ? {
                partial: {
                  ...(this.textDeltas.length ? { content: this.textDeltas.join('') } : {}),
                  ...(this.thinkingDeltas.length ? { thinking: this.thinkingDeltas.join('') } : {}),
                  ...(this.observedToolCalls() ? { tool_calls: this.observedToolCalls() } : {}),
                },
              }
            : {}),
          ...('error' in outcome ? { error: snapshotError(outcome.error) } : {}),
          ...(errorTiming ? { timing: errorTiming } : {}),
          ...(outcome.termination !== undefined ? { termination: outcome.termination } : {}),
        });
        this.channel.noteOperation({
          operationId: this.operationId,
          kind: this.kind,
          attempt: Math.max(1, this.attempts),
          status: 'recorded',
        });
      },
      outcome.termination === 'aborted' ||
        outcome.termination === 'stalled' ||
        outcome.termination === 'consumer_closed'
        ? outcome.termination
        : 'error' in outcome
          ? 'error'
          : outcome.response
            ? 'ok'
            : 'unfinished',
    );
  }
}

function openProviderOperation(
  raw: Provider,
  kind: 'chat' | 'stream',
  options: ChatOptions,
): OperationHandle | undefined {
  const handle = openOperation({
    kind,
    model: options.model,
    diagnosticModelUri: options.accountingModelUri,
    provider: raw.name,
    agentCall: options.accountingModelUri !== undefined,
  });
  // Only an adapter that declares it reports transport dispatch can prove that
  // a usage-less failure was never billed. Everyone else stays conservative.
  if (handle && raw.reportsRequestLifecycle === true) handle.markDispatchObservable();
  return handle;
}

/** Runtime-owned telemetry settings; the manager getter sees late initialization. */
export type ScopedProviderTelemetry = {
  getSpanManager(): SpanManager | undefined;
  captureContent: boolean;
  redact: boolean;
};

type InferenceObserver = {
  onDispatch(): void;
  observe(chunk: StreamChunk): void;
  end(
    response?: Parameters<typeof genAiInferenceEnd>[0]['response'],
    error?: unknown,
    cause?: string,
  ): void;
};

function inferenceErrorType(error: unknown): string {
  if (error instanceof StallTimeoutError) return 'stalled';
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return error.name;
  }
  return 'error';
}

function createInferenceObserver(
  telemetry: ScopedProviderTelemetry | undefined,
  raw: Provider,
  messages: readonly ChatMessage[],
  options: ChatOptions,
  stream: boolean,
): InferenceObserver | undefined {
  let manager: SpanManager | undefined;
  try {
    manager = telemetry?.getSpanManager();
    if (!manager?.startSpan || !telemetry) return undefined;
  } catch {
    return undefined;
  }
  const issuedAtEpochMs = Date.now();
  const issuedAtMonotonicMs = performance.now();
  const content =
    telemetry.captureContent && !telemetry.redact && stream ? new GenAiStreamContent() : undefined;
  let attempted = false;
  let closed = false;
  let span: SpanHandle | undefined;
  let firstChunkMs: number | undefined;

  return {
    onDispatch(): void {
      if (attempted || closed) return;
      attempted = true;
      try {
        let reported: string | undefined;
        // providerOptions merges after the portable effort mapping. Even an
        // unrelated-looking key may change a provider-native reasoning field,
        // so the reporting hook is not a truthful wire source in that case.
        let canTrustEffort = false;
        try {
          canTrustEffort =
            options.providerOptions === undefined ||
            Object.keys(options.providerOptions).length === 0;
        } catch {
          // A hostile options getter cannot turn a guess into a wire claim.
        }
        if (canTrustEffort) {
          try {
            reported = raw.effortResolution?.(options)?.effective;
          } catch {
            /* An optional diagnostic hook cannot suppress the span. */
          }
        }
        const effectiveReasoningLevel =
          reported &&
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reported)
            ? reported
            : undefined;
        const mapped = genAiInferenceStart({
          providerId: raw.name ?? 'unknown',
          options,
          stream,
          sessionId: currentCaptureTurn()?.sessionId,
          effectiveReasoningLevel,
          messages,
          captureContent: telemetry.captureContent,
          redact: telemetry.redact,
        });
        span = manager.startSpan!(mapped.name, mapped.attributes, {
          kind: 'client',
          startTime: issuedAtEpochMs,
        });
      } catch {
        // Telemetry is diagnostic. Projection or a custom span manager must
        // never alter provider dispatch, accounting, or capture.
      }
    },
    observe(chunk): void {
      if (!span || closed) return;
      if (firstChunkMs === undefined)
        firstChunkMs = Math.max(0, performance.now() - issuedAtMonotonicMs);
      try {
        content?.observe(chunk);
      } catch {
        // A custom chunk getter may throw. The provider's own result wins.
      }
    },
    end(response, error, cause): void {
      if (closed) return;
      closed = true;
      if (!span) return;
      try {
        const captured = content?.snapshot();
        const failed = error !== undefined || (cause !== undefined && cause !== 'consumer_closed');
        const attributes = genAiInferenceEnd({
          response: { ...captured?.response, ...response },
          firstChunkMs,
          errorType:
            cause === 'aborted' || cause === 'stalled'
              ? cause
              : error !== undefined
                ? inferenceErrorType(error)
                : failed
                  ? cause
                  : undefined,
          captureContent: telemetry.captureContent,
          redact: telemetry.redact,
          omitContent: captured?.omitContent,
        });
        for (const [key, value] of Object.entries(attributes)) {
          try {
            span.setAttribute(key, value);
          } catch {
            /* Keep closing the span. */
          }
        }
        try {
          span.setStatus(failed ? 'error' : cause === 'consumer_closed' ? 'unset' : 'ok');
        } catch {
          /* Keep closing the span. */
        }
      } catch {
        // Even a failed result projection must not keep a live span open.
      } finally {
        try {
          span.end();
        } catch {
          /* Telemetry must not change the result. */
        }
      }
    },
  };
}

/**
 * Wrap `raw` in an accounting/admission and optional telemetry facade.
 *
 * Prefer `runtime.resolveProvider()`, which caches one facade per raw adapter
 * per runtime so repeated resolutions keep facade identity.
 */
export function createScopedProvider(raw: Provider, telemetry?: ScopedProviderTelemetry): Provider {
  // `get` returns the SAME function object for a given property across calls so
  // that `p.chat === p.chat` and consumers can compare or unsubscribe.
  const boundCache = new Map<PropertyKey, unknown>();

  const chat = async (messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> => {
    const handle = openProviderOperation(raw, 'chat', options);
    const inference = createInferenceObserver(telemetry, raw, messages, options, false);
    // Snapshot BEFORE dispatch. `beginCapture` reads the request by value, so a
    // caller (or the adapter) mutating `messages`/`options` afterwards cannot
    // rewrite history.
    const recorder = handle ? beginCapture(raw, 'chat', handle.id, messages, options) : undefined;
    try {
      const invoke = () => {
        if (raw.reportsRequestLifecycle !== true) {
          recorder?.markDispatch();
          inference?.onDispatch();
        }
        return raw.chat(
          messages,
          instrumentedOptions(
            options,
            handle,
            raw.reportsRequestLifecycle === true ? recorder : undefined,
            inference?.onDispatch,
          ),
        );
      };
      const response = await (handle ? handle.run(invoke) : invoke());
      handle?.settle({
        cost: response.cost,
        provenance: response.costProvenance,
        usage: toAccountingUsage(response.usage),
        timing: safeTiming(response),
      });
      recorder?.end({ response });
      inference?.end(response);
      return response;
    } catch (error) {
      // Settlement first, then rethrow the ORIGINAL value untouched — an
      // AdmissionDeniedError raised by our own dispatch hook has already
      // retracted the operation, and `settleFailure` is a no-op after that.
      handle?.settleFailure();
      recorder?.end({ error, termination: recorder.termination(undefined, error) });
      inference?.end(undefined, error);
      throw error;
    }
  };

  /**
   * A hand-rolled delegating iterator rather than an `async function*`.
   *
   * A generator suspended at `await inner.next()` cannot process a `return()`
   * until that await settles, so wrapping the adapter in one would break the
   * runtime's stall path: `stallTimeout` closes a stream whose `next()` never
   * resolves by calling `return()` on it, and that call must reach the adapter
   * immediately. Delegating explicitly keeps `return`/`throw` synchronous with
   * respect to the inner iterator.
   */
  const stream = (messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> => {
    let inner: AsyncGenerator<StreamChunk> | undefined;
    let handle: OperationHandle | undefined;
    let recorder: CaptureRecorder | undefined;
    let inference: InferenceObserver | undefined;
    let started = false;
    let settled = false;
    let finished = false;

    /**
     * Terminal without a `done` chunk — a throw, an early `return()`, or a
     * stream that just ended. All are dispatched work whose charge we could not
     * establish. No-op once the `done` chunk already settled the operation.
     *
     * The record is sealed on the SAME paths that settle the operation, with
     * the reason it ended. A stall-timeout close and a call that never came
     * back are different findings, and `start_only` only stays meaningful if
     * the deliberate closes are labelled as such.
     */
    const settleUnresolved = (termination: string, error?: unknown): void => {
      if (settled) return;
      settled = true;
      handle?.settleFailure();
      const cause = recorder?.termination(termination, error);
      if (error !== undefined) recorder?.end({ error, ...(cause ? { termination: cause } : {}) });
      else recorder?.end({ ...(cause ? { termination: cause } : {}) });
      inference?.end(
        undefined,
        error,
        cause ??
          currentCaptureTurn()?.terminationCause ??
          (options.signal?.aborted
            ? 'aborted'
            : termination === 'consumer_closed'
              ? 'consumer_closed'
              : 'incomplete'),
      );
    };

    // Deferred to the first `next()`: the admission check, the operation and
    // the raw `stream()` call must land in the scope active when iteration
    // actually begins, not the one that merely built the generator.
    const start = (): void => {
      started = true;
      handle = openProviderOperation(raw, 'stream', options);
      inference = createInferenceObserver(telemetry, raw, messages, options, true);
      // Capture opens at the first `next()`, in the scope that actually began
      // iteration — the same rule the operation itself follows.
      if (handle) recorder = beginCapture(raw, 'stream', handle.id, messages, options);
      const invoke = () => {
        if (raw.reportsRequestLifecycle !== true) {
          recorder?.markDispatch();
          inference?.onDispatch();
        }
        return raw.stream(
          messages,
          instrumentedOptions(
            options,
            handle,
            raw.reportsRequestLifecycle === true ? recorder : undefined,
            inference?.onDispatch,
          ),
        );
      };
      const source = handle ? handle.run(invoke) : invoke();
      // An adapter may return a bare async-iterable rather than a generator, so
      // take its iterator explicitly instead of assuming `next` sits on the
      // returned object.
      const iterable = source as AsyncIterable<StreamChunk> & AsyncGenerator<StreamChunk>;
      inner =
        typeof iterable[Symbol.asyncIterator] === 'function'
          ? (iterable[Symbol.asyncIterator]() as AsyncGenerator<StreamChunk>)
          : iterable;
    };

    const generator: AsyncGenerator<StreamChunk> = {
      async next(): Promise<IteratorResult<StreamChunk>> {
        if (finished) return { value: undefined, done: true };
        if (!started) {
          try {
            start();
          } catch (error) {
            finished = true;
            // Two throws reach here. An admission denial from `openOperation`
            // leaves `handle` undefined and has already recorded the
            // retraction, so this is a no-op. An adapter whose `stream()`
            // throws synchronously (a non-generator implementation that
            // validates eagerly) leaves an OPENED operation that nothing can
            // ever settle, since `finished` blocks every later call — settle it
            // here rather than letting the scope report it as `abandoned` at
            // finalization.
            settleUnresolved('stream failed to start', error);
            throw error;
          }
        }
        try {
          const result = await inner!.next();
          if (result.done === true) {
            finished = true;
            settleUnresolved('stream ended without a done chunk');
            return result;
          }
          inference?.observe(result.value);
          if (result.value.type === 'done') {
            handle?.settle({
              cost: result.value.cost,
              provenance: result.value.costProvenance,
              usage: toAccountingUsage(result.value.usage),
              timing: safeTiming(result.value),
            });
            settled = true;
            // The terminal chunk closes the same captured operation as the
            // earlier text, thinking and tool-call deltas.
            recorder?.endStream(result.value);
            inference?.end(result.value);
          } else {
            recorder?.observeChunk(result.value);
          }
          return result;
        } catch (error) {
          finished = true;
          settleUnresolved('stream threw mid-iteration', error);
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<StreamChunk>> {
        finished = true;
        // The runtime's stall-timeout close and a consumer `break` both land
        // here.
        settleUnresolved('consumer_closed');
        // `return` is optional on a plain async iterator.
        if (inner?.return) return inner.return(value as never);
        return { value: value as never, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<StreamChunk>> {
        finished = true;
        settleUnresolved('consumer_closed', error);
        if (inner?.throw) return inner.throw(error);
        throw error;
      },
      [Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
        return generator;
      },
      async [Symbol.asyncDispose](): Promise<void> {
        await generator.return(undefined);
      },
    };
    return generator;
  };

  return new Proxy(raw, {
    get(target, prop, _receiver): unknown {
      if (prop === 'chat') return chat;
      if (prop === 'stream') return stream;
      const cached = boundCache.get(prop);
      if (cached !== undefined) return cached;
      // `target` as the receiver, not the proxy: accessors and methods that
      // touch class private fields (`this.#x`) throw on a proxy receiver.
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        boundCache.set(prop, bound);
        return bound;
      }
      return value;
    },
    set(target, prop, value): boolean {
      // Writes land on the adapter, and a later read sees them because `get`
      // forwards. Invalidate any cached binding for that property.
      boundCache.delete(prop);
      return Reflect.set(target, prop, value, target);
    },
    deleteProperty(target, prop): boolean {
      boundCache.delete(prop);
      return Reflect.deleteProperty(target, prop);
    },
    defineProperty(target, prop, descriptor): boolean {
      boundCache.delete(prop);
      return Reflect.defineProperty(target, prop, descriptor);
    },
  });
}
