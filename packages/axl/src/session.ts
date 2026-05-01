import type { ChatMessage, HandoffRecord } from './types.js';
import type { StateStore } from './state/types.js';
import type { AxlRuntime } from './runtime.js';
import type { AxlStream } from './stream.js';

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

  async send(workflowName: string, input: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Session has been ended');
    return this.runtime._serializeSession(this.sessionId, () => this.sendImpl(workflowName, input));
  }

  private async sendImpl(workflowName: string, input: unknown): Promise<unknown> {
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

    const userMessage: ChatMessage = {
      role: 'user',
      content: typeof input === 'string' ? input : JSON.stringify(input),
    };
    history.push(userMessage);

    const result = await this.runtime.execute(workflowName, input, {
      metadata: {
        sessionId: this.sessionId,
        sessionHistory: history,
        ...(cachedSummary ? { summaryCache: cachedSummary } : {}),
      },
    });

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
    return result;
  }

  async stream(workflowName: string, input: unknown): Promise<AxlStream> {
    if (this.closed) throw new Error('Session has been ended');

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
        this.streamImpl(workflowName, input, resolveReady, rejectReady),
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
  ): Promise<void> {
    let history: ChatMessage[];
    let axlStream: AxlStream;
    try {
      history = await this.store.getSession(this.sessionId);
      let cachedSummary = (await this.store.getSessionMeta(this.sessionId, 'summaryCache')) as
        | string
        | null;

      // Apply maxMessages limit
      const maxMessages = this.options.history?.maxMessages;
      if (maxMessages && history.length > maxMessages) {
        if (this.options.history?.summarize) {
          const summaryModel = this.options.history?.summaryModel;
          if (!summaryModel) {
            throw new Error(
              'SessionOptions.history.summaryModel is required when summarize is true',
            );
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

      const userMessage: ChatMessage = {
        role: 'user',
        content: typeof input === 'string' ? input : JSON.stringify(input),
      };
      history.push(userMessage);

      axlStream = this.runtime.stream(workflowName, input, {
        metadata: {
          sessionId: this.sessionId,
          sessionHistory: history,
          ...(cachedSummary ? { summaryCache: cachedSummary } : {}),
        },
      });
    } catch (err) {
      rejectReady(err);
      throw err;
    }

    const updateHistory = async (result: unknown): Promise<void> => {
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
    };

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
        updateHistory(result).catch((err) => {
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

  async fork(newId: string): Promise<Session> {
    // Read the source under the source's lock so we capture history
    // *after* any in-flight send/stream commits, not a torn snapshot.
    return this.runtime._serializeSession(this.sessionId, async () => {
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

      return forked;
    });
  }
}
