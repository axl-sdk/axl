import { InvalidModelInputError } from './errors.js';
import type { ChatMessage } from './types.js';

/** Ordered, model-facing input. Strings retain the legacy shorthand. */
export type ModelInput = string | readonly InputContentPart[];

export type InputTextPart = { readonly type: 'text'; readonly text: string };

export type InputMediaSource =
  | { readonly type: 'url'; readonly url: string; readonly mediaType?: string }
  | { readonly type: 'bytes'; readonly data: Uint8Array; readonly mediaType: string }
  | { readonly type: 'base64'; readonly data: string; readonly mediaType: string }
  | {
      readonly type: 'provider-file';
      readonly provider: string;
      readonly reference: string;
      readonly mediaType?: string;
    };

export type InputImagePart = {
  readonly type: 'image';
  readonly source: InputMediaSource;
  readonly label?: string;
};

export type InputContentPart = InputTextPart | InputImagePart;

/** Bounded, observation-safe representation of a rich input. */
export type ModelInputDescriptor = {
  readonly parts: readonly (
    | { readonly type: 'text'; readonly characters: number }
    | {
        readonly type: 'image';
        readonly source: InputMediaSource['type'];
        readonly mediaType?: string;
        readonly bytes?: number;
        readonly locator?: string;
        readonly label?: string;
      }
  )[];
};

function invalid(message: string): never {
  throw new InvalidModelInputError(message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid(`${field} must be a non-empty string`);
  return value;
}

function mediaType(value: unknown, field: string): string {
  return nonEmptyString(value, field);
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** Validate and take private ownership of an input once per ask. */
export function normalizeModelInput(input: ModelInput): ModelInput {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.length === 0)
    invalid('ModelInput parts must be a non-empty array');

  return input.map((part, index): InputContentPart => {
    if (!part || typeof part !== 'object') invalid(`ModelInput part ${index} must be an object`);
    if (part.type === 'text')
      return { type: 'text', text: nonEmptyString(part.text, `part ${index}.text`) };
    if (part.type !== 'image') invalid(`part ${index}.type must be 'text' or 'image'`);
    const source = part.source;
    if (!source || typeof source !== 'object') invalid(`part ${index}.source must be an object`);
    let clone: InputMediaSource;
    switch (source.type) {
      case 'url': {
        const url = nonEmptyString(source.url, `part ${index}.source.url`);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          invalid(`part ${index}.source.url must be an http(s) URL`);
        }
        if (parsed!.protocol !== 'http:' && parsed!.protocol !== 'https:')
          invalid(`part ${index}.source.url must be an http(s) URL`);
        clone = {
          type: 'url',
          url,
          ...(source.mediaType === undefined
            ? {}
            : { mediaType: mediaType(source.mediaType, `part ${index}.source.mediaType`) }),
        };
        break;
      }
      case 'bytes':
        if (!(source.data instanceof Uint8Array) || source.data.byteLength === 0)
          invalid(`part ${index}.source.data must be a non-empty Uint8Array`);
        clone = {
          type: 'bytes',
          data: source.data.slice(),
          mediaType: mediaType(source.mediaType, `part ${index}.source.mediaType`),
        };
        break;
      case 'base64': {
        const data = nonEmptyString(source.data, `part ${index}.source.data`);
        if (!validBase64(data)) invalid(`part ${index}.source.data must be valid base64`);
        clone = {
          type: 'base64',
          data,
          mediaType: mediaType(source.mediaType, `part ${index}.source.mediaType`),
        };
        break;
      }
      case 'provider-file':
        clone = {
          type: 'provider-file',
          provider: nonEmptyString(source.provider, `part ${index}.source.provider`),
          reference: nonEmptyString(source.reference, `part ${index}.source.reference`),
          ...(source.mediaType === undefined
            ? {}
            : { mediaType: mediaType(source.mediaType, `part ${index}.source.mediaType`) }),
        };
        break;
      default:
        invalid(`part ${index}.source.type is unsupported`);
    }
    return {
      type: 'image',
      source: clone,
      ...(part.label === undefined
        ? {}
        : { label: nonEmptyString(part.label, `part ${index}.label`) }),
    };
  });
}

/** Return legacy text unchanged, or the deterministic ordered text projection. */
export function inputText(input: ModelInput): string {
  return typeof input === 'string'
    ? input
    : input
        .filter((part): part is InputTextPart => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

/** Give mutation-capable consumers an independent model-input view. */
export function cloneModelInput(input: ModelInput): ModelInput {
  return typeof input === 'string' ? input : normalizeModelInput(input);
}

/** Build the bounded descriptor used at observability boundaries. */
export function describeModelInput(input: ModelInput): ModelInputDescriptor | undefined {
  if (typeof input === 'string') return undefined;
  return {
    parts: input.map((part) => {
      if (part.type === 'text') return { type: 'text' as const, characters: part.text.length };
      const { source } = part;
      return {
        type: 'image' as const,
        source: source.type,
        ...(source.mediaType ? { mediaType: source.mediaType } : {}),
        ...(source.type === 'bytes' ? { bytes: source.data.byteLength } : {}),
        ...(source.type === 'base64'
          ? {
              bytes:
                Math.floor((source.data.length * 3) / 4) -
                (source.data.endsWith('==') ? 2 : source.data.endsWith('=') ? 1 : 0),
            }
          : {}),
        ...((
          source.type === 'url'
            ? source.url
            : source.type === 'provider-file'
              ? source.reference
              : undefined
        )
          ? {
              locator:
                source.type === 'url'
                  ? source.url
                  : source.type === 'provider-file'
                    ? source.reference
                    : undefined,
            }
          : {}),
        ...(part.label ? { label: part.label } : {}),
      };
    }),
  };
}

/** Safe representation for context summarizers; never includes locators or data. */
export function summarizeModelInput(input: ModelInput): string {
  if (typeof input === 'string') return input;
  return input
    .map((part) =>
      part.type === 'text' ? part.text : `[image ${part.source.mediaType ?? 'media'}]`,
    )
    .join('\n');
}

/** Keep full trace snapshots bounded even when the runtime sends rich messages. */
export function sanitizeModelInputForTrace(input: ModelInput): string {
  return inputText(input);
}

/** Validate and clone only history shapes that are safe for JSON-backed state.
 * Inline Uint8Array is deliberately per-call evidence and must never be
 * silently coerced by a state store. */
export function normalizePersistedSessionHistory(history: ChatMessage[]): ChatMessage[] {
  return history.map((message, index) => {
    if (typeof message.content === 'string') return { ...message };
    if (message.role !== 'user') {
      throw new InvalidModelInputError(
        `History message ${index} has non-text content on a non-user role`,
      );
    }
    const content = normalizeModelInput(message.content);
    if (
      typeof content !== 'string' &&
      content.some((part) => part.type === 'image' && part.source.type === 'bytes')
    ) {
      throw new InvalidModelInputError(
        'Uint8Array image input cannot be persisted in session history',
      );
    }
    return { ...message, content };
  });
}
