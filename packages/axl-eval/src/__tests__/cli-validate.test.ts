import { describe, it, expect } from 'vitest';
import { validateEvalConfig } from '../cli-validate.js';

/**
 * The CLI's eval-config validator is the boundary between "user wrote a
 * file we can run" and "garbage we'd otherwise fail on with a confusing
 * stack trace deep inside `runEval`." Pin the diagnostic strings so a
 * regression that softens the messages becomes a visible test failure.
 */
describe('validateEvalConfig', () => {
  const validDataset = { getItems: async () => [] };
  const validScorer = { name: 'acc', score: () => 1 };

  it('returns undefined for a fully-valid config', () => {
    expect(
      validateEvalConfig({
        workflow: 'my-workflow',
        dataset: validDataset,
        scorers: [validScorer],
      }),
    ).toBeUndefined();
  });

  it('rejects null', () => {
    expect(validateEvalConfig(null)).toMatch(/got null/);
  });

  it('rejects primitives with the typeof in the message', () => {
    expect(validateEvalConfig(42)).toMatch(/got number/);
    expect(validateEvalConfig('foo')).toMatch(/got string/);
    expect(validateEvalConfig(true)).toMatch(/got boolean/);
  });

  it('lists missing fields and shows what keys WERE present', () => {
    const msg = validateEvalConfig({ scorerS: [] });
    expect(msg).toMatch(/missing workflow, dataset, scorers/);
    // Surfaces the typo'd key so the user can spot `scorerS` vs `scorers`
    expect(msg).toMatch(/Got: { scorerS }/);
  });

  it('rejects empty scorers array specifically', () => {
    expect(
      validateEvalConfig({
        workflow: 'w',
        dataset: validDataset,
        scorers: [],
      }),
    ).toMatch(/empty scorers array/);
  });

  it('rejects scorers array with non-callable entries', () => {
    const msg = validateEvalConfig({
      workflow: 'w',
      dataset: validDataset,
      scorers: [validScorer, null, validScorer],
    });
    expect(msg).toMatch(/non-scorer entry at index 1/);
    expect(msg).toMatch(/score\(\) method/);
  });

  it('rejects a scorer object that has no .score method', () => {
    const msg = validateEvalConfig({
      workflow: 'w',
      dataset: validDataset,
      scorers: [{ name: 'oops' }],
    });
    expect(msg).toMatch(/non-scorer entry at index 0/);
  });

  it('rejects non-string workflow', () => {
    const msg = validateEvalConfig({
      workflow: { name: 'nope' },
      dataset: validDataset,
      scorers: [validScorer],
    });
    expect(msg).toMatch(/non-string workflow/);
  });

  it('rejects array dataset (common bug: passed dataset items directly)', () => {
    const msg = validateEvalConfig({
      workflow: 'w',
      dataset: [{ input: 1 }, { input: 2 }],
      scorers: [validScorer],
    });
    expect(msg).toMatch(/non-object dataset/);
    expect(msg).toMatch(/dataset\(\) factory/);
  });

  it('rejects dataset without getItems()', () => {
    const msg = validateEvalConfig({
      workflow: 'w',
      dataset: { name: 'ds' },
      scorers: [validScorer],
    });
    expect(msg).toMatch(/getItems\(\) method/);
  });

  it('truncates Got: { ... } hint at 10 keys', () => {
    const cfg: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) cfg[`k${i}`] = i;
    const msg = validateEvalConfig(cfg);
    // 10 keys present, the 11th is dropped — fewer commas means truncation
    // happened. Asserting the precise key list keeps the truncation
    // boundary contractual.
    expect(msg).toMatch(/Got: { k0, k1, k2, k3, k4, k5, k6, k7, k8, k9 }/);
    expect(msg).not.toMatch(/k10/);
  });
});
