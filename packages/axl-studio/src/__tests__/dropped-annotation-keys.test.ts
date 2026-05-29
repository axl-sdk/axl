import { describe, it, expect } from 'vitest';
import {
  getResultDroppedAnnotationKeys,
  type EvalResultData,
} from '../client/panels/eval-runner/types.js';

/**
 * The eval runner surfaces annotation keys the dataset schema stripped into
 * `EvalResult.metadata.droppedAnnotationKeys`; the Eval Runner panel reads them
 * via this helper to render the amber "N annotation keys dropped" banner. This
 * verifies the read is null-safe and filters non-string junk, since `metadata`
 * is an untyped `Record<string, unknown>` that can carry anything from
 * imported CLI artifacts.
 */
function makeResult(metadata?: Record<string, unknown>): EvalResultData {
  return {
    id: 'r1',
    dataset: 'ds',
    timestamp: '2026-05-29T00:00:00.000Z',
    duration: 1,
    totalCost: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(metadata ? { metadata } : {}),
  };
}

describe('getResultDroppedAnnotationKeys', () => {
  it('returns the dropped key paths from metadata', () => {
    const result = makeResult({ droppedAnnotationKeys: ['expectedTone', 'persona.role'] });
    expect(getResultDroppedAnnotationKeys(result)).toEqual(['expectedTone', 'persona.role']);
  });

  it('returns [] when metadata is absent', () => {
    expect(getResultDroppedAnnotationKeys(makeResult())).toEqual([]);
  });

  it('returns [] when the key is absent', () => {
    expect(getResultDroppedAnnotationKeys(makeResult({ models: ['openai:gpt-4o'] }))).toEqual([]);
  });

  it('filters non-string entries from a malformed/imported payload', () => {
    const result = makeResult({ droppedAnnotationKeys: ['ok', 42, null, { x: 1 }] });
    expect(getResultDroppedAnnotationKeys(result)).toEqual(['ok']);
  });

  it('returns [] when the value is not an array', () => {
    expect(getResultDroppedAnnotationKeys(makeResult({ droppedAnnotationKeys: 'oops' }))).toEqual(
      [],
    );
  });
});
