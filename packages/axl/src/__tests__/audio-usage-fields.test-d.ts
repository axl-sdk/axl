import { describe, expectTypeOf, it } from 'vitest';
import type { StreamChunk } from '../providers/types.js';
import type { AxlEventBase, ProviderResponse } from '../types.js';

// ---------------------------------------------------------------------------
// The audio usage split lands on BOTH usage shapes, identically, and stays
// OPTIONAL on both. `ProviderResponse.usage` and the `done` chunk's `usage`
// are separate inline types on the public surface, and streaming is the
// default whenever an observer is attached — a field on only one of them
// silently loses the split for streaming consumers (matrix T077/T078, plan G11).
//
// `AxlEventBase.tokens` is deliberately NOT widened (plan G12): a modality
// token breakdown on events is a separate observability decision with its own
// Studio work. This fixture makes widening it a visible choice (T079).
// ---------------------------------------------------------------------------

type ProviderUsage = NonNullable<ProviderResponse['usage']>;
type DoneUsage = NonNullable<Extract<StreamChunk, { type: 'done' }>['usage']>;

describe('audio usage fields', () => {
  it('T078: are optional numbers on both usage shapes', () => {
    expectTypeOf<ProviderUsage['audio_input_tokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ProviderUsage['audio_output_tokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<DoneUsage['audio_input_tokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<DoneUsage['audio_output_tokens']>().toEqualTypeOf<number | undefined>();
  });

  it('T078: keep the two usage shapes in field parity', () => {
    expectTypeOf<keyof ProviderUsage>().toEqualTypeOf<keyof DoneUsage>();
  });

  it('T078: a custom Provider that omits them still constructs a valid usage', () => {
    const usage: ProviderUsage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const done: DoneUsage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    expectTypeOf(usage).toMatchTypeOf<ProviderUsage>();
    expectTypeOf(done).toMatchTypeOf<DoneUsage>();
  });

  it('T079: AxlEventBase.tokens is unchanged — no audio bucket', () => {
    expectTypeOf<keyof NonNullable<AxlEventBase['tokens']>>().toEqualTypeOf<
      'input' | 'output' | 'reasoning' | 'cached' | 'cacheWrite'
    >();
  });
});
