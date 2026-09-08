import { InvalidModelInputError } from './errors.js';
// Type-only: `transcription.ts` imports only `./errors.js`, so reusing its
// finite-audio vocabulary here introduces no module cycle.
import type { RecordedAudioSource } from './transcription.js';
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

/** A finite recording supplied as ordered model input. Sources are shared with
 * `ctx.transcribe()`, which makes audio URLs unrepresentable by construction. */
export type InputAudioPart = {
  readonly type: 'audio';
  readonly source: RecordedAudioSource;
  readonly label?: string;
};

export type InputContentPart = InputTextPart | InputImagePart | InputAudioPart;

/** Maximum decoded bytes retained across all inline media in one logical input. */
export const MAX_INLINE_MODEL_INPUT_BYTES = 25 * 1024 * 1024;

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
    | {
        readonly type: 'audio';
        readonly source: RecordedAudioSource['type'];
        readonly mediaType?: string;
        readonly bytes?: number;
        /** Provider-file reference only; audio has no URL source. */
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

function decodedBase64Bytes(value: string): number {
  return (
    Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  );
}

const INLINE_MEDIA_LIMIT_MESSAGE =
  'Inline media data must not exceed 25 MiB total; use a provider-file source, or a URL for images, where supported';

const IMAGE_SOURCE_TYPES = ['url', 'bytes', 'base64', 'provider-file'] as const;
const AUDIO_SOURCE_TYPES = ['bytes', 'base64', 'provider-file'] as const;

/** Validate and copy one media source. Image and audio share every source
 * shape they have in common; only the admissible set differs, so the allowed
 * kinds are the parameter rather than the modality. */
function cloneMediaSource<K extends InputMediaSource['type']>(
  source: unknown,
  index: number,
  allowed: readonly K[],
  reserveInlineBytes: (bytes: number) => void,
): Extract<InputMediaSource, { type: K }> {
  if (!source || typeof source !== 'object') invalid(`part ${index}.source must be an object`);
  const raw = source as Record<string, unknown>;
  const kind = raw.type;
  if (typeof kind !== 'string' || !(allowed as readonly string[]).includes(kind))
    invalid(`part ${index}.source.type is unsupported`);
  let clone: InputMediaSource;
  switch (kind) {
    case 'url': {
      const url = nonEmptyString(raw.url, `part ${index}.source.url`);
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
        ...(raw.mediaType === undefined
          ? {}
          : { mediaType: mediaType(raw.mediaType, `part ${index}.source.mediaType`) }),
      };
      break;
    }
    case 'bytes': {
      if (!(raw.data instanceof Uint8Array) || raw.data.byteLength === 0)
        invalid(`part ${index}.source.data must be a non-empty Uint8Array`);
      // Enforce the aggregate bound before taking the ownership copy.
      reserveInlineBytes(raw.data.byteLength);
      clone = {
        type: 'bytes',
        data: raw.data.slice(),
        mediaType: mediaType(raw.mediaType, `part ${index}.source.mediaType`),
      };
      break;
    }
    case 'base64': {
      const data = nonEmptyString(raw.data, `part ${index}.source.data`);
      // Reject by encoded length before the regex scans an arbitrarily large
      // value. Padding is accounted for after syntax validation.
      if (data.length > 4 * Math.ceil(MAX_INLINE_MODEL_INPUT_BYTES / 3))
        invalid(INLINE_MEDIA_LIMIT_MESSAGE);
      if (!validBase64(data)) invalid(`part ${index}.source.data must be valid base64`);
      reserveInlineBytes(decodedBase64Bytes(data));
      clone = {
        type: 'base64',
        data,
        mediaType: mediaType(raw.mediaType, `part ${index}.source.mediaType`),
      };
      break;
    }
    default:
      clone = {
        type: 'provider-file',
        provider: nonEmptyString(raw.provider, `part ${index}.source.provider`),
        reference: nonEmptyString(raw.reference, `part ${index}.source.reference`),
        ...(raw.mediaType === undefined
          ? {}
          : { mediaType: mediaType(raw.mediaType, `part ${index}.source.mediaType`) }),
      };
  }
  // Narrowing is established by the `allowed` membership check above.
  return clone as Extract<InputMediaSource, { type: K }>;
}

/** Validate and take private ownership of an input once per ask. */
export function normalizeModelInput(input: ModelInput): ModelInput {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.length === 0)
    invalid('ModelInput parts must be a non-empty array');

  // One logical input carries one inline budget, shared across every modality.
  let inlineBytes = 0;
  const reserveInlineBytes = (bytes: number) => {
    if (bytes > MAX_INLINE_MODEL_INPUT_BYTES - inlineBytes) invalid(INLINE_MEDIA_LIMIT_MESSAGE);
    inlineBytes += bytes;
  };

  return input.map((part, index): InputContentPart => {
    if (!part || typeof part !== 'object') invalid(`ModelInput part ${index} must be an object`);
    // `label` belongs to the media parts only: a text part has no label field
    // in `InputTextPart`, and the normalized text part drops one, so
    // validating it there would reject an input that normalizes fine.
    const mediaLabel = () =>
      part.label === undefined ? {} : { label: nonEmptyString(part.label, `part ${index}.label`) };
    switch (part.type) {
      case 'text':
        return { type: 'text', text: nonEmptyString(part.text, `part ${index}.text`) };
      case 'image':
        return {
          type: 'image',
          source: cloneMediaSource(part.source, index, IMAGE_SOURCE_TYPES, reserveInlineBytes),
          ...mediaLabel(),
        };
      case 'audio':
        return {
          type: 'audio',
          source: cloneMediaSource(part.source, index, AUDIO_SOURCE_TYPES, reserveInlineBytes),
          ...mediaLabel(),
        };
      default:
        invalid(`part ${index}.type must be 'text', 'image', or 'audio'`);
    }
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

/** Exhaustiveness guard so a newly added modality cannot silently fall through
 * an observability projection as some other modality. */
function unsupportedPart(part: never): never {
  return invalid(
    `Unsupported model input part type '${String((part as { type?: unknown }).type)}'`,
  );
}

/** Structural, byte-free view of one media source. */
function describeSource<S extends InputMediaSource>(
  source: S,
  label: string | undefined,
): {
  source: S['type'];
  mediaType?: string;
  bytes?: number;
  locator?: string;
  label?: string;
} {
  // Widened alias so the discriminant narrows; `source.type` keeps the caller's
  // narrower modality-specific source union in the descriptor.
  const media: InputMediaSource = source;
  const locator =
    media.type === 'url' ? media.url : media.type === 'provider-file' ? media.reference : undefined;
  return {
    source: source.type,
    ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    ...(media.type === 'bytes' ? { bytes: media.data.byteLength } : {}),
    ...(media.type === 'base64' ? { bytes: decodedBase64Bytes(media.data) } : {}),
    ...(locator ? { locator } : {}),
    ...(label ? { label } : {}),
  };
}

/** Build the bounded descriptor used at observability boundaries. */
export function describeModelInput(input: ModelInput): ModelInputDescriptor | undefined {
  if (typeof input === 'string') return undefined;
  return {
    parts: input.map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'text' as const, characters: part.text.length };
        case 'image':
          return { type: 'image' as const, ...describeSource(part.source, part.label) };
        case 'audio':
          return { type: 'audio' as const, ...describeSource(part.source, part.label) };
        default:
          return unsupportedPart(part);
      }
    }),
  };
}

/** Safe representation for context summarizers; never includes locators or data. */
export function summarizeModelInput(input: ModelInput): string {
  if (typeof input === 'string') return input;
  return input
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'image':
          return `[image ${part.source.mediaType ?? 'media'}]`;
        case 'audio':
          return `[audio ${part.source.mediaType ?? 'media'}]`;
        default:
          return unsupportedPart(part);
      }
    })
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
      content.some((part) => part.type !== 'text' && part.source.type === 'bytes')
    ) {
      throw new InvalidModelInputError(
        'Uint8Array media input cannot be persisted in session history',
      );
    }
    return { ...message, content };
  });
}
