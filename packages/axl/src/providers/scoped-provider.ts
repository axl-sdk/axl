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
 * Outside an accounting scope the facade delegates verbatim: no admission
 * check, no operation, no observable difference.
 */

import { openOperation, type AccountingUsage, type OperationHandle } from '../accounting.js';
import {
  currentCaptureChannel,
  currentCaptureCorrelation,
  currentCaptureTurn,
  snapshotError,
  snapshotRequest,
  snapshotResponse,
  type CapturedRequestRecord,
  type RequestCaptureChannel,
} from '../diagnostics/capture.js';
import { redactCapturedRequest } from '../redaction.js';
import type { ProviderResponse } from '../types.js';
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
  handle: OperationHandle,
  recorder?: CaptureRecorder,
): ChatOptions {
  return {
    ...options,
    requestLifecycle: composeLifecycle(options.requestLifecycle, () => {
      handle.markDispatched();
      recorder?.markDispatch();
    }),
    dispatchAdmission: handle.dispatchAdmission,
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
  return new CaptureRecorder(channel, raw.name ?? 'unknown', kind, operationId, messages, options);
}

class CaptureRecorder {
  private attempts = 0;
  private ended = false;
  private readonly turn: ReturnType<typeof currentCaptureTurn>;
  private readonly correlation: ReturnType<typeof currentCaptureCorrelation>;
  private readonly omitted: string[];

  constructor(
    private readonly channel: RequestCaptureChannel,
    private readonly provider: string,
    private readonly kind: 'chat' | 'stream',
    private readonly operationId: string,
    messages: readonly ChatMessage[],
    private readonly options: ChatOptions,
  ) {
    const turn = currentCaptureTurn();
    const correlation = currentCaptureCorrelation();
    this.turn = turn;
    this.correlation = correlation;
    const { request, omitted } = snapshotRequest(messages, options);
    this.omitted = omitted;
    channel.noteOperation({
      operationId,
      kind,
      ...(turn?.turn !== undefined ? { turn: turn.turn } : {}),
      status: 'start_only',
      ...(correlation?.caseIndex !== undefined ? { caseIndex: correlation.caseIndex } : {}),
      ...(correlation?.scorer !== undefined ? { scorer: correlation.scorer } : {}),
    });
    this.emit({ phase: 'start', transportAttempts: 1, request });
  }

  private emit(
    partial: Pick<CapturedRequestRecord, 'phase' | 'transportAttempts'> &
      Partial<CapturedRequestRecord>,
  ): void {
    const record: CapturedRequestRecord = {
      v: 1,
      operationId: this.operationId,
      kind: this.kind,
      provider: this.provider,
      model: this.options.model,
      ...(this.correlation?.caseIndex !== undefined
        ? { caseIndex: this.correlation.caseIndex }
        : {}),
      ...(this.correlation?.scorer !== undefined ? { scorer: this.correlation.scorer } : {}),
      ...(this.turn?.executionId !== undefined ? { executionId: this.turn.executionId } : {}),
      ...(this.turn?.askId !== undefined ? { askId: this.turn.askId } : {}),
      ...(this.turn?.parentAskId !== undefined ? { parentAskId: this.turn.parentAskId } : {}),
      ...(this.turn?.turn !== undefined ? { turn: this.turn.turn } : {}),
      ...(this.turn?.retryReason !== undefined ? { retryReason: this.turn.retryReason } : {}),
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

  /** A transport attempt beyond the first: the SAME operation, retried. */
  markDispatch(): void {
    this.attempts += 1;
    if (this.attempts <= 1) return;
    this.emit({ phase: 'attempt', transportAttempts: this.attempts });
    this.channel.noteOperation({
      operationId: this.operationId,
      kind: this.kind,
      attempt: this.attempts,
      status: 'start_only',
    });
  }

  end(outcome: { response?: ProviderResponse; error?: unknown }): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({
      phase: 'end',
      transportAttempts: Math.max(1, this.attempts),
      ...(outcome.response ? { response: snapshotResponse(outcome.response) } : {}),
      ...('error' in outcome ? { error: snapshotError(outcome.error) } : {}),
    });
    this.channel.noteOperation({
      operationId: this.operationId,
      kind: this.kind,
      attempt: Math.max(1, this.attempts),
      status: 'recorded',
    });
  }
}

function openProviderOperation(
  raw: Provider,
  kind: 'chat' | 'stream',
  options: ChatOptions,
): OperationHandle | undefined {
  const handle = openOperation({ kind, model: options.model, provider: raw.name });
  // Only an adapter that declares it reports transport dispatch can prove that
  // a usage-less failure was never billed. Everyone else stays conservative.
  if (handle && raw.reportsRequestLifecycle === true) handle.markDispatchObservable();
  return handle;
}

/**
 * Wrap `raw` in an accounting/admission facade.
 *
 * Prefer `runtime.resolveProvider()`, which caches one facade per raw adapter
 * per runtime so repeated resolutions keep facade identity.
 */
export function createScopedProvider(raw: Provider): Provider {
  // `get` returns the SAME function object for a given property across calls so
  // that `p.chat === p.chat` and consumers can compare or unsubscribe.
  const boundCache = new Map<PropertyKey, unknown>();

  const chat = async (messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> => {
    const handle = openProviderOperation(raw, 'chat', options);
    if (!handle) return raw.chat(messages, options);
    // Snapshot BEFORE dispatch. `beginCapture` reads the request by value, so a
    // caller (or the adapter) mutating `messages`/`options` afterwards cannot
    // rewrite history.
    const recorder = beginCapture(raw, 'chat', handle.id, messages, options);
    try {
      const response = await handle.run(() =>
        raw.chat(messages, instrumentedOptions(options, handle, recorder)),
      );
      handle.settle({
        cost: response.cost,
        provenance: response.costProvenance,
        usage: toAccountingUsage(response.usage),
      });
      recorder?.end({ response });
      return response;
    } catch (error) {
      // Settlement first, then rethrow the ORIGINAL value untouched — an
      // AdmissionDeniedError raised by our own dispatch hook has already
      // retracted the operation, and `settleFailure` is a no-op after that.
      handle.settleFailure();
      recorder?.end({ error });
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
    let started = false;
    let settled = false;
    let finished = false;

    /**
     * Terminal without a `done` chunk — a throw, an early `return()`, or a
     * stream that just ended. All are dispatched work whose charge we could not
     * establish. No-op once the `done` chunk already settled the operation.
     */
    const settleUnresolved = (): void => {
      if (settled) return;
      settled = true;
      handle?.settleFailure();
    };

    // Deferred to the first `next()`: the admission check, the operation and
    // the raw `stream()` call must land in the scope active when iteration
    // actually begins, not the one that merely built the generator.
    const start = (): void => {
      started = true;
      handle = openProviderOperation(raw, 'stream', options);
      // Capture opens at the first `next()`, in the scope that actually began
      // iteration — the same rule the operation itself follows.
      if (handle) recorder = beginCapture(raw, 'stream', handle.id, messages, options);
      const source = handle
        ? handle.run(() => raw.stream(messages, instrumentedOptions(options, handle!, recorder)))
        : raw.stream(messages, options);
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
            settleUnresolved();
            recorder?.end({ error });
            throw error;
          }
        }
        try {
          const result = await inner!.next();
          if (result.done === true) {
            finished = true;
            settleUnresolved();
            return result;
          }
          if (result.value.type === 'done') {
            handle?.settle({
              cost: result.value.cost,
              provenance: result.value.costProvenance,
              usage: toAccountingUsage(result.value.usage),
            });
            settled = true;
            // The `done` chunk is a stream's response: link its usage/cost to
            // the same operation id the start record opened.
            recorder?.end({
              response: {
                content: '',
                ...(result.value.usage ? { usage: result.value.usage } : {}),
                ...(result.value.cost !== undefined ? { cost: result.value.cost } : {}),
                ...(result.value.costProvenance !== undefined
                  ? { costProvenance: result.value.costProvenance }
                  : {}),
              } as ProviderResponse,
            });
          }
          return result;
        } catch (error) {
          finished = true;
          settleUnresolved();
          recorder?.end({ error });
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<StreamChunk>> {
        finished = true;
        settleUnresolved();
        // `return` is optional on a plain async iterator.
        if (inner?.return) return inner.return(value as never);
        return { value: value as never, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<StreamChunk>> {
        finished = true;
        settleUnresolved();
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
