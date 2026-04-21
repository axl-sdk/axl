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

    const axlStream = this.runtime.stream(workflowName, input, {
      metadata: {
        sessionId: this.sessionId,
        sessionHistory: history,
        ...(cachedSummary ? { summaryCache: cachedSummary } : {}),
      },
    });

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

    axlStream.on('done', (event: unknown) => {
      // The unified event model wraps the result in `data: { result }` on
      // `done` events (spec §2.1) — extract and pass the inner result to
      // the legacy updateHistory path.
      const data = (event as { data: { result: unknown } }).data;
      updateHistory(data.result).catch((err) => {
        this.runtime.emit('error', {
          type: 'session_history_save_failed',
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    return axlStream;
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
    this.closed = true;
    if (this.options.persist !== false) {
      await this.store.deleteSession(this.sessionId);
    }
  }

  async fork(newId: string): Promise<Session> {
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
  }
}
