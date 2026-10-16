import type { FinishReason } from '../types.js';

/** A malformed or empty wire string is absent, not a synthetic identifier or reason. */
export function reportedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function openAIChatFinishReason(raw: string | undefined): FinishReason | undefined {
  if (raw === undefined) return undefined;
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'refusal':
      return raw;
    default:
      return 'other';
  }
}

export function openAIResponsesFinishReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasFunctionCall: boolean,
): { finishReason?: FinishReason; rawFinishReason?: string } {
  if (status === 'incomplete') {
    const rawFinishReason = incompleteReason ?? status;
    return {
      rawFinishReason,
      finishReason:
        incompleteReason === 'max_output_tokens'
          ? 'length'
          : incompleteReason === 'content_filter'
            ? 'content_filter'
            : 'other',
    };
  }
  if (status === 'completed') {
    return { rawFinishReason: status, finishReason: hasFunctionCall ? 'tool_calls' : 'stop' };
  }
  if (status !== undefined) return { rawFinishReason: status, finishReason: 'other' };
  if (hasFunctionCall) return { finishReason: 'tool_calls' };
  return {};
}

export function anthropicFinishReason(raw: string | undefined): FinishReason | undefined {
  if (raw === undefined) return undefined;
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export function geminiFinishReason(
  raw: string | undefined,
  hasFunctionCall: boolean,
): FinishReason | undefined {
  if (raw === undefined) return hasFunctionCall ? 'tool_calls' : undefined;
  if (raw === 'STOP') return hasFunctionCall ? 'tool_calls' : 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  return 'other';
}

export function geminiInteractionFinishReason(
  raw: string | undefined,
  hasFunctionCall: boolean,
): FinishReason | undefined {
  if (raw === undefined) return hasFunctionCall ? 'tool_calls' : undefined;
  if (raw === 'completed') return 'stop';
  if (raw === 'requires_action' && hasFunctionCall) return 'tool_calls';
  return 'other';
}
