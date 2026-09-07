/**
 * Media type → OpenAI Chat Completions `input_audio.format` tokens.
 *
 * Chat Completions carries recorded audio as `{ data, format }`, where `format`
 * is a short wire token — NOT a media type. The mapping is therefore explicit
 * and CLOSED per profile: a media type we cannot map faithfully is rejected
 * locally (naming the type) rather than sent for the provider to 400 on, and a
 * format token is never derived from the media type by string surgery
 * (`audio/mpeg`.split('/')[1] would yield the invalid token `mpeg`).
 *
 * The tables deliberately differ: OpenAI documents exactly `wav | mp3`, while
 * OpenRouter's audio guide accepts a wider set. Keep them separate — copying
 * the wider table onto the OpenAI profile would ship formats OpenAI rejects.
 *
 * Dependency-free by design so profiles can import it without pulling in the
 * engine.
 */

/** OpenAI Chat Completions (`input_audio.format` enum is exactly `wav | mp3`). */
export const OPENAI_CHAT_AUDIO_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
});

/**
 * OpenRouter — the OpenAI rows plus its documented extras.
 *
 * `pcm24` is documented by OpenRouter but has no IANA media type that
 * distinguishes it from `pcm16` (`audio/l16` is 16-bit by definition), so it is
 * deliberately unmapped: a caller cannot express it unambiguously today.
 */
export const OPENROUTER_AUDIO_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  ...OPENAI_CHAT_AUDIO_FORMATS,
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/l16': 'pcm16',
});

/**
 * Resolve a caller-declared media type against a profile's closed table.
 *
 * RFC 2045 media types are case-insensitive and may carry parameters
 * (`audio/L16; rate=16000`), both of which callers legitimately produce; the
 * table is keyed by the bare lowercase type. Returns `undefined` when the type
 * is not mappable — callers must reject rather than guess a format.
 */
export function resolveAudioFormat(
  formats: Readonly<Record<string, string>>,
  mediaType: string | undefined,
): string | undefined {
  if (typeof mediaType !== 'string') return undefined;
  const essence = mediaType.split(';', 1)[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(formats, essence) ? formats[essence] : undefined;
}
