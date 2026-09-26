import type { ChatMessage } from './types.js';

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
