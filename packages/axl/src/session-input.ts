import { cloneModelInput, normalizeModelInput, summarizeModelInput } from './input.js';
import type { InputContentPart, InputMediaSource, ModelInput } from './input.js';
import type { ChatMessage } from './types.js';

const MODEL_INPUT_PART_TYPES: ReadonlySet<unknown> = new Set(['text', 'image', 'audio']);

type SessionInputMarker = {
  message: ChatMessage;
  content: string;
  normalizedInput: ModelInput;
};

/** Request-local provenance keyed by the exact history array owned by one Session call. */
const sessionInputMarkers = new WeakMap<ChatMessage[], SessionInputMarker>();

/** A workflow input shaped like ordered `ModelInput` parts. Any other
 * non-string input is an application object and is recorded as JSON. */
function isModelInputParts(input: unknown): input is readonly unknown[] {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        MODEL_INPUT_PART_TYPES.has((part as { type?: unknown }).type),
    )
  );
}

/**
 * Own the original session input before prepareHistory awaits store work. Rich
 * media remains per-call evidence while its persisted turn is a safe text
 * projection. Application objects match only an ask containing their exact
 * serialized JSON string.
 */
export function prepareSessionInput(input: unknown): {
  content: string;
  normalizedInput?: ModelInput;
} {
  if (typeof input === 'string') return { content: input, normalizedInput: input };
  if (isModelInputParts(input)) {
    const normalizedInput = normalizeModelInput(input as unknown as ModelInput);
    return { content: summarizeModelInput(normalizedInput), normalizedInput };
  }
  const content = JSON.stringify(input);
  // Preserve the historical runtime behavior for inputs such as undefined,
  // functions, and symbols: JSON.stringify produces undefined and the session
  // projection carries it through. Such a value is not a ModelInput and must
  // not acquire dedup provenance or fail before its workflow runs.
  return {
    content: content as string,
    ...(typeof content === 'string' ? { normalizedInput: content } : {}),
  };
}

export function registerSessionInput(
  history: ChatMessage[],
  message: ChatMessage,
  normalizedInput: ModelInput,
): void {
  sessionInputMarkers.set(history, {
    message,
    content: message.content as string,
    normalizedInput: cloneModelInput(normalizedInput),
  });
}

/** Clear media-bearing provenance at the terminal boundary, success or failure. */
export function clearSessionInput(history: ChatMessage[]): void {
  sessionInputMarkers.delete(history);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function equalSource(left: InputMediaSource, right: InputMediaSource): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case 'url':
      return right.type === 'url' && left.url === right.url && left.mediaType === right.mediaType;
    case 'bytes':
      return (
        right.type === 'bytes' &&
        left.mediaType === right.mediaType &&
        equalBytes(left.data, right.data)
      );
    case 'base64':
      return (
        right.type === 'base64' && left.data === right.data && left.mediaType === right.mediaType
      );
    case 'provider-file':
      return (
        right.type === 'provider-file' &&
        left.provider === right.provider &&
        left.reference === right.reference &&
        left.mediaType === right.mediaType
      );
  }
}

function equalPart(left: InputContentPart, right: InputContentPart): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'text') return right.type === 'text' && left.text === right.text;
  return (
    right.type === left.type && left.label === right.label && equalSource(left.source, right.source)
  );
}

function equalModelInput(left: ModelInput, right: ModelInput): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return (
    left.length === right.length && left.every((part, index) => equalPart(part, right[index]!))
  );
}

/**
 * Snapshot history for one ask and omit only the exact, unchanged user object
 * recorded for this Session call when the ask repeats the normalized input.
 */
export function sessionHistoryForAsk(
  history: ChatMessage[],
  normalizedInput: ModelInput,
): ChatMessage[] {
  const snapshot = history.slice();
  const marker = sessionInputMarkers.get(history);
  if (!marker) return snapshot;

  const last = snapshot[snapshot.length - 1];
  if (
    last !== marker.message ||
    last.role !== 'user' ||
    last.content !== marker.content ||
    !equalModelInput(marker.normalizedInput, normalizedInput)
  ) {
    return snapshot;
  }

  snapshot.pop();
  return snapshot;
}
