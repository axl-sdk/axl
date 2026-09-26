import { createHash } from 'node:crypto';
import { summarizeModelInput } from './input.js';
import type { Provider } from './providers/types.js';
import type { ChatMessage, ProviderResponse } from './types.js';

/**
 * Client-side history compaction shared by the two summarizers: session
 * retention (`SessionOptions.history.summarize`, via
 * `AxlRuntime.summarizeMessages`) and ask projection (`AgentConfig.maxContext`,
 * via `WorkflowContext`). Both send the same prompt through the same call so a
 * summary means the same thing whichever boundary produced it.
 */

export const SUMMARY_SYSTEM_PROMPT =
  'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation.';

export const SUMMARY_MAX_TOKENS = 1024;

/** Render the summarizer's user turn. A previous summary leads so the new
 * summary folds it in rather than dropping what it alone still carries. */
export function buildSummaryPrompt(
  messages: readonly ChatMessage[],
  previousSummary?: string,
): string {
  return [
    ...(previousSummary ? [`Previous conversation summary: ${previousSummary}`] : []),
    ...messages.map((m) => `${m.role}: ${summarizeModelInput(m.content)}`),
  ].join('\n');
}

/** The single summarization provider call. Callers own events and accounting. */
export function requestSummary(
  provider: Provider,
  options: { model: string; prompt: string; signal?: AbortSignal },
): Promise<ProviderResponse> {
  return provider.chat(
    [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: options.prompt },
    ],
    {
      model: options.model,
      maxTokens: SUMMARY_MAX_TOKENS,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/** The runtime-authored message that carries a summary into a model request. */
export function summaryContextMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    origin: 'runtime',
    content: `Summary of earlier conversation:\n${summary}`,
  };
}

// ── Signed-thinking invalidation ─────────────────────────────────────────

/**
 * A client-written summary changes the prefix to which Anthropic thinking is
 * signed. Remove only those opaque blocks from turns carried across that known
 * rewrite; text, tool calls, and other providers' metadata remain intact.
 */
export function withoutAnthropicThinking(message: ChatMessage): ChatMessage {
  const metadata = message.providerMetadata;
  if (!metadata || !Object.hasOwn(metadata, 'anthropicThinkingBlocks')) return message;

  const retainedMetadata = { ...metadata };
  delete retainedMetadata.anthropicThinkingBlocks;
  return {
    ...message,
    ...(Object.keys(retainedMetadata).length > 0
      ? { providerMetadata: retainedMetadata }
      : { providerMetadata: undefined }),
  };
}

/** Thinking blocks the Anthropic adapter would have replayed from this message:
 * the ones `withoutAnthropicThinking` removes from the request. */
export function anthropicThinkingBlockCount(message: ChatMessage): number {
  const blocks = message.providerMetadata?.anthropicThinkingBlocks;
  if (!Array.isArray(blocks)) return 0;
  return blocks.filter(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      ((block as { type?: unknown }).type === 'thinking' ||
        (block as { type?: unknown }).type === 'redacted_thinking'),
  ).length;
}

// ── Persisted ask-summary boundary ───────────────────────────────────────

/**
 * One agent's `maxContext` summary of an exact session-history prefix, stored
 * as session metadata under {@link askSummaryMetaKey}. It is a disposable
 * projection: never the durable `summaryCache`, never a reason to trim history.
 */
export type AskSummaryRecord = {
  summary: string;
  /** Number of leading history messages the summary covers. */
  coveredCount: number;
  /** SHA-256 of the canonical JSON of `history.slice(0, coveredCount)`. */
  prefixHash: string;
  /** The durable session summary folded into `summary`, if any. */
  sourceSummary?: string;
  summaryModelUri: string;
  /** History index below which retained turns lose Anthropic thinking. */
  invalidatedThinkingThrough: number;
};

export function askSummaryMetaKey(agentName: string): string {
  return `askSummary:${agentName}`;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Accept only a complete record; anything else from a store is a cache miss. */
export function parseAskSummaryRecord(value: unknown): AskSummaryRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== 'string' ||
    !isCount(record.coveredCount) ||
    typeof record.prefixHash !== 'string' ||
    typeof record.summaryModelUri !== 'string' ||
    !isCount(record.invalidatedThinkingThrough) ||
    (record.sourceSummary !== undefined && typeof record.sourceSummary !== 'string')
  ) {
    return undefined;
  }
  return {
    summary: record.summary,
    coveredCount: record.coveredCount,
    prefixHash: record.prefixHash,
    ...(record.sourceSummary !== undefined ? { sourceSummary: record.sourceSummary } : {}),
    summaryModelUri: record.summaryModelUri,
    invalidatedThinkingThrough: record.invalidatedThinkingThrough,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Hash of an exact history prefix that survives a JSON state-store round trip:
 * object keys are sorted (stores may reorder them) and `undefined` members are
 * dropped exactly as `JSON.stringify` drops them on persistence. Returns
 * `undefined` when the prefix cannot be serialized (for example cyclic custom
 * metadata); callers then regenerate instead of reusing.
 */
export function summaryPrefixHash(
  history: readonly ChatMessage[],
  coveredCount: number,
): string | undefined {
  let canonical: string;
  try {
    canonical = JSON.stringify(history.slice(0, coveredCount), (_key, value: unknown) =>
      isPlainObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
  } catch {
    return undefined;
  }
  return createHash('sha256').update(canonical).digest('hex');
}
