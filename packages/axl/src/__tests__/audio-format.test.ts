import { describe, expect, it } from 'vitest';
import {
  OPENAI_CHAT_AUDIO_FORMATS,
  OPENROUTER_AUDIO_FORMATS,
  resolveAudioFormat,
} from '../providers/audio-format.js';

/**
 * The closed media type → `input_audio.format` tables (plan R-A6) and their
 * resolver. Every documented row is asserted explicitly: the tables are a wire
 * contract, so a silently dropped or retyped row is a live behavior change.
 */

const OPENAI_ROWS: ReadonlyArray<[string, string]> = [
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
];

const OPENROUTER_EXTRA_ROWS: ReadonlyArray<[string, string]> = [
  ['audio/aiff', 'aiff'],
  ['audio/x-aiff', 'aiff'],
  ['audio/aac', 'aac'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
  ['audio/m4a', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/mp4', 'm4a'],
  ['audio/l16', 'pcm16'],
];

describe('audio media-type format tables (R-A6)', () => {
  it('maps exactly the OpenAI Chat Completions rows', () => {
    expect(OPENAI_CHAT_AUDIO_FORMATS).toEqual(Object.fromEntries(OPENAI_ROWS));
    // The documented `input_audio.format` enum is exactly wav | mp3.
    expect([...new Set(Object.values(OPENAI_CHAT_AUDIO_FORMATS))].sort()).toEqual(['mp3', 'wav']);
  });

  it('maps the OpenAI rows plus the OpenRouter extras, and nothing else', () => {
    expect(OPENROUTER_AUDIO_FORMATS).toEqual(
      Object.fromEntries([...OPENAI_ROWS, ...OPENROUTER_EXTRA_ROWS]),
    );
  });

  it('keeps the OpenAI table strictly narrower than the OpenRouter table', () => {
    // Copying the wider table onto the OpenAI profile would ship formats the
    // OpenAI enum rejects; the two must not converge.
    for (const [mediaType] of OPENROUTER_EXTRA_ROWS) {
      expect(OPENAI_CHAT_AUDIO_FORMATS[mediaType]).toBeUndefined();
    }
    expect(Object.keys(OPENAI_CHAT_AUDIO_FORMATS).length).toBeLessThan(
      Object.keys(OPENROUTER_AUDIO_FORMATS).length,
    );
  });

  it('leaves pcm24 unmapped on both profiles', () => {
    // No IANA media type distinguishes 24-bit PCM from `audio/l16`; a caller
    // cannot express it unambiguously, so it is deliberately absent.
    for (const table of [OPENAI_CHAT_AUDIO_FORMATS, OPENROUTER_AUDIO_FORMATS]) {
      expect(Object.values(table)).not.toContain('pcm24');
    }
  });

  it('is frozen, so one profile cannot mutate another profile’s table', () => {
    expect(Object.isFrozen(OPENAI_CHAT_AUDIO_FORMATS)).toBe(true);
    expect(Object.isFrozen(OPENROUTER_AUDIO_FORMATS)).toBe(true);
  });
});

describe('resolveAudioFormat', () => {
  it.each(OPENAI_ROWS)('resolves %s to %s on the OpenAI table', (mediaType, format) => {
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, mediaType)).toBe(format);
  });

  it.each([...OPENAI_ROWS, ...OPENROUTER_EXTRA_ROWS])(
    'resolves %s to %s on the OpenRouter table',
    (mediaType, format) => {
      expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, mediaType)).toBe(format);
    },
  );

  it('lowercases the media type (RFC 2045 types are case-insensitive)', () => {
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'AUDIO/L16')).toBe('pcm16');
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, 'Audio/WAV')).toBe('wav');
  });

  it('strips media-type parameters before lookup', () => {
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'audio/L16; rate=16000')).toBe('pcm16');
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, 'audio/wav;codecs=1')).toBe('wav');
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, '  audio/mpeg  ')).toBe('mp3');
  });

  it('returns undefined for an unmapped type rather than guessing a format', () => {
    // A `split('/')[1]` implementation would answer `mpeg`/`webm` here.
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, 'audio/x-unknown')).toBeUndefined();
    expect(resolveAudioFormat(OPENAI_CHAT_AUDIO_FORMATS, 'audio/ogg')).toBeUndefined();
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'audio/webm')).toBeUndefined();
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'video/mp4')).toBeUndefined();
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, undefined)).toBeUndefined();
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, '')).toBeUndefined();
  });

  it('never resolves an inherited Object.prototype key', () => {
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'constructor')).toBeUndefined();
    expect(resolveAudioFormat(OPENROUTER_AUDIO_FORMATS, 'toString')).toBeUndefined();
  });
});
