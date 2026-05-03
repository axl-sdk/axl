import type { ChatMessage, HandoffRecord } from './types.js';
import type { StateStore } from './state/types.js';
import type { AxlRuntime } from './runtime.js';
import type { AxlStream } from './stream.js';
import type { EventStreamOptions } from './event-stream.js';

/** Options for configuring a session. */
export type SessionOptions = {
  /** History management options. */
  history?: {
    /** Maximum number of messages to keep in history. Older messages are trimmed (or summarized if summarize is true). */
    maxMessages?: number;
    /** When true and maxMessages is exceeded, summarize old messages instead of dropping them. Requires summaryModel to be set. Default: false. */
    summarize?: boolean;
    /** Model URI to use for summarization (e.g., 'openai:gpt-4o-mini'). Required when summarize is true. */
    summaryModel?: string;
  };
  /** Whether to persist session history to the state store. Default: true. */
  persist?: boolean;
};

/**
 * A stateful conversation session.
 * Persists message history across multiple interactions.
 *
 * **Concurrency contract:** `send`, `stream`, `end`, and `fork` are
 * serialized per session id within one runtime instance. Two
 * `runtime.session('x')` handles share the same lock (it lives on
 * `AxlRuntime`, not the `Session` instance). `history()` and
 * `handoffs()` bypass the lock and return the last persisted snapshot.
 *
 * **⚠️ Cross-process locking is NOT provided.** Multiple Node workers
 * behind a load balancer hitting the same Redis-backed `sessionId`
 * will still race. Pin sessions to workers (sticky routing) or use
 * distinct ids per request. See `docs/api-reference.md` →
 * Sessions → Concurrency.
 */
export class Session {
  private closed = false;
  private options: SessionOptions;

  constructor(
    private sessionId: string,
    private runtime: AxlRuntime,
    private store: StateStore,
    options?: SessionOptions,
  ) {
    this.options = options ?? {};
  }

  get id(): string {
    return this.sessionId;
  }

  async send(
    workflowName: string,
    input: unknown,
    options?: { signal?: AbortSignal; events?: EventStreamOptions },
  ): Promise<unknown> {
    if (this.closed) throw new Error('Session has been ended');
    // Fast-path: a pre-aborted signal short-circuits before we acquire the
    // per-session lock, so an aborted call never blocks other waiters.
    options?.signal?.throwIfAborted?.();
    return this.runtime._serializeSession(this.sessionId, () =>
      this.sendImpl(workflowName, input, options?.signal, options?.events),
    );
  }

  private async sendImpl(
    workflowName: string,
    input: unknown,
    signal: AbortSignal | undefined,
    events: EventStreamOptions | undefined,
  ): Promise<unknown> {
    const { history, metadata } = await this.prepareHistory(input);
    const result = await this.runtime.execute(workflowName, input, { metadata, signal, events });
    await this.commitHistory(history, result);
    return result;
  }

  /** Read history + summary, apply maxMessages limit (with optional
   *  summarization), and push the new user message. Returns the mutable
   *  `history` array (which `executeAgentCall` will append the assistant
   *  reply to in-place) and the `metadata` payload to forward to
   *  `runtime.execute()` / `runtime.stream()`. Shared by `sendImpl` and
   *  `streamImpl` so future fixes (e.g., to summarization wiring) land in
   *  one place. */
  private async prepareHistory(input: unknown): Promise<{
    history: ChatMessage[];
    metadata: Record<string, unknown>;
  }> {
    const history = await this.store.getSession(this.sessionId);
    let cachedSummary = (await this.store.getSessionMeta(this.sessionId, 'summaryCache')) as
      | string
      | null;

    // Apply maxMessages limit
    const maxMessages = this.options.history?.maxMessages;
    if (maxMessages && history.length > maxMessages) {
      if (this.options.history?.summarize) {
        const summaryModel = this.options.history?.summaryModel;
        if (!summaryModel) {
          throw new Error('SessionOptions.history.summaryModel is required when summarize is true');
        }
        const messagesToDrop = history.slice(0, history.length - maxMessages);
        // Include existing summary as context for the new summarization
        const toSummarize: ChatMessage[] = cachedSummary
          ? [
              { role: 'system', content: `Previous conversation summary: ${cachedSummary}` },
              ...messagesToDrop,
            ]
          : messagesToDrop;
        const summary = await this.runtime.summarizeMessages(toSummarize, summaryModel);
        await this.store.saveSessionMeta(this.sessionId, 'summaryCache', summary);
        // Update local reference so the workflow receives the fresh summary
        cachedSummary = summary;
      }
      const trimmed = history.slice(-maxMessages);
      history.length = 0;
      history.push(...trimmed);
    }

    history.push({
      role: 'user',
      content: typeof input === 'string' ? input : JSON.stringify(input),
    });

    const metadata: Record<string, unknown> = {
      sessionId: this.sessionId,
      sessionHistory: history,
      ...(cachedSummary ? { summaryCache: cachedSummary } : {}),
    };
    return { history, metadata };
  }

  /** Push the assistant reply (if `executeAgentCall` didn't already) and
   *  persist. Shared by `sendImpl` and `streamImpl`. The fallback assistant
   *  push has no agent context and so leaves `agent` undefined — see the
   *  `ChatMessage.agent` field doc. */
  private async commitHistory(history: ChatMessage[], result: unknown): Promise<void> {
    // executeAgentCall may have already pushed the assistant message (with
    // providerMetadata for Gemini thought signatures etc.). Only add one if needed.
    const lastMsg = history[history.length - 1];
    if (!(lastMsg && lastMsg.role === 'assistant')) {
      history.push({
        role: 'assistant',
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    if (this.options.persist !== false) {
      await this.store.saveSession(this.sessionId, history);
    }
  }

  async stream(
    workflowName: string,
    input: unknown,
    options?: { signal?: AbortSignal; events?: EventStreamOptions },
  ): Promise<AxlStream> {
    if (this.closed) throw new Error('Session has been ended');
    options?.signal?.throwIfAborted?.();

    // The serializer holds the lock until `done`/`error` so the next caller
    // sees a saved history. `streamReady` resolves once the AxlStream object
    // is constructed, so callers don't have to wait for the stream to finish.
    let resolveReady!: (s: AxlStream) => void;
    let rejectReady!: (e: unknown) => void;
    const streamReady = new Promise<AxlStream>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    // Don't await — the serializer call blocks until the stream completes,
    // which is what we want for the lock chain (the next caller queues
    // behind it). Failures during prep are surfaced via `rejectReady`,
    // which is what the caller awaits. The serializer's promise must be
    // caught here to suppress an unhandled rejection on the runtime side
    // — the chain itself is error-swallowed (see `_serializeSession`),
    // but `ours` (the value returned from `_serializeSession`) carries
    // the rejection through.
    void this.runtime
      ._serializeSession(this.sessionId, () =>
        this.streamImpl(
          workflowName,
          input,
          resolveReady,
          rejectReady,
          options?.signal,
          options?.events,
        ),
      )
      .catch(() => {
        /* surfaced via rejectReady */
      });

    return streamReady;
  }

  private async streamImpl(
    workflowName: string,
    input: unknown,
    resolveReady: (s: AxlStream) => void,
    rejectReady: (e: unknown) => void,
    signal: AbortSignal | undefined,
    events: EventStreamOptions | undefined,
  ): Promise<void> {
    let history: ChatMessage[];
    let axlStream: AxlStream;
    try {
      const prepared = await this.prepareHistory(input);
      history = prepared.history;
      axlStream = this.runtime.stream(workflowName, input, {
        metadata: prepared.metadata,
        signal,
        events,
      });
    } catch (err) {
      rejectReady(err);
      throw err;
    }

    // Hand the stream to the caller now — the lock is still held by the
    // `await completion` below, so the next session call queues behind it.
    resolveReady(axlStream);

    // Hold the lock until the stream terminates. `axlStream.promise`
    // resolves on the `done` event (with the result) and rejects on
    // `error`; using it instead of `on('done'|'error', ...)` avoids any
    // listener-vs-sync-emit ordering risk. Save only on success — an
    // errored stream has no committed result.
    const completion = axlStream.promise.then(
      (result) =>
        this.commitHistory(history, result).catch((err) => {
          this.runtime.emit('error', {
            type: 'session_history_save_failed',
            sessionId: this.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      () => undefined,
    );
    await completion;
  }

  async history(): Promise<ChatMessage[]> {
    return this.store.getSession(this.sessionId);
  }

  /** Get the handoff history for this session. */
  async handoffs(): Promise<HandoffRecord[]> {
    return (
      ((await this.store.getSessionMeta(this.sessionId, 'handoffHistory')) as HandoffRecord[]) ?? []
    );
  }

  async end(): Promise<void> {
    // Mark closed *before* the lock so concurrent send()/stream() calls
    // that haven't yet acquired the lock fail fast at their `if (closed)`
    // check. The lock acquisition still serializes the actual delete
    // against any in-flight save.
    this.closed = true;
    return this.runtime._serializeSession(this.sessionId, async () => {
      if (this.options.persist !== false) {
        await this.store.deleteSession(this.sessionId);
      }
    });
  }

  async fork(newId: string, options?: { overwrite?: boolean }): Promise<Session> {
    if (newId === this.sessionId) {
      throw new Error(`Session.fork: newId must differ from source id (${this.sessionId})`);
    }
    // Acquire BOTH the source and target locks. Source so we read a
    // committed snapshot (not torn vs an in-flight send); target so the
    // writes to `newId` don't race a concurrent `runtime.session(newId)`
    // operation. Acquired in lexicographic order to make crossed forks
    // (A→B and B→A concurrent) deadlock-free.
    const [first, second] = [this.sessionId, newId].sort();
    return this.runtime._serializeSession(first, () =>
      this.runtime._serializeSession(second, async () => {
        // Refuse to clobber an existing target unless the caller opted in.
        // This prevents accidental data loss when a fork is fired into a
        // session id that's already in use.
        if (!options?.overwrite) {
          const existing = await this.store.getSession(newId);
          if (existing.length > 0) {
            throw new Error(
              `Session.fork: target id "${newId}" already has history. ` +
                `Pass { overwrite: true } to replace it, or choose a different id.`,
            );
          }
        }

        const history = await this.store.getSession(this.sessionId);
        const forked = new Session(newId, this.runtime, this.store, this.options);
        await this.store.saveSession(newId, [...history]);

        // Copy session metadata (e.g. summaryCache, handoffHistory) to the forked session
        const summaryCache = await this.store.getSessionMeta(this.sessionId, 'summaryCache');
        if (summaryCache !== null) {
          await this.store.saveSessionMeta(newId, 'summaryCache', summaryCache);
        }

        const handoffHistory = await this.store.getSessionMeta(this.sessionId, 'handoffHistory');
        if (handoffHistory !== null) {
          await this.store.saveSessionMeta(newId, 'handoffHistory', handoffHistory);
        }

        // Copy session-scoped key-value memory. Vector embeddings (when
        // `remember(..., {embed: true})`) are NOT copied — re-embed on
        // the fork if you need semantic recall there. Stores that don't
        // implement `getAllMemory`/`saveMemory` (e.g., the current
        // RedisStore) silently skip this; their memory uses the
        // sessionMeta fallback path which isn't enumerable per session.
        if (this.store.getAllMemory && this.store.saveMemory) {
          const sourceScope = `session:${this.sessionId}`;
          const targetScope = `session:${newId}`;
          const entries = await this.store.getAllMemory(sourceScope);
          for (const { key, value } of entries) {
            await this.store.saveMemory(targetScope, key, value);
          }
        }

        return forked;
      }),
    );
  }
}
