import { describe, expectTypeOf, it } from 'vitest';
import type { InputAudioPart } from '../input.js';
import type { RecordedAudioSource } from '../transcription.js';

// ---------------------------------------------------------------------------
// `InputAudioPart.source` reuses `RecordedAudioSource` so that an audio URL is
// unrepresentable by construction. That coupling cuts both ways: widening the
// transcription source union (say, to accept a URL for `ctx.transcribe()`)
// would silently widen what every audio adapter must handle. This guard makes
// that widening a deliberate, compile-time-visible decision.
// ---------------------------------------------------------------------------

describe('RecordedAudioSource is the closed recorded-audio union', () => {
  it('is exactly bytes | base64 | provider-file', () => {
    expectTypeOf<RecordedAudioSource['type']>().toEqualTypeOf<
      'bytes' | 'base64' | 'provider-file'
    >();
    expectTypeOf<InputAudioPart['source']>().toEqualTypeOf<RecordedAudioSource>();
  });
});
