import { describe, it, expect } from 'vitest';
import { FALLBACK_TOKENS_PER_CHAR, TokenRatioCalibrator } from '../token-calibration.js';

describe('TokenRatioCalibrator', () => {
  it('reports the cold-start density until a model has a usable sample', () => {
    const calibrator = new TokenRatioCalibrator();
    expect(calibrator.tokensPerChar('any-model')).toBe(FALLBACK_TOKENS_PER_CHAR);
    expect(calibrator.observedTokensPerChar('any-model')).toBeUndefined();
  });

  it('adopts the first observation and smooths later ones toward it', () => {
    const calibrator = new TokenRatioCalibrator();

    // 1000 chars billed as 500 tokens => 0.5 tokens per char.
    calibrator.observe('m', 1000, 500);
    expect(calibrator.tokensPerChar('m')).toBeCloseTo(0.5, 10);

    // A denser second turn moves the ratio part of the way, not all the way:
    // one atypical turn must not swing the compaction threshold.
    calibrator.observe('m', 1000, 900);
    const smoothed = calibrator.tokensPerChar('m');
    expect(smoothed).toBeGreaterThan(0.5);
    expect(smoothed).toBeLessThan(0.9);
  });

  it('converges toward a steady density over repeated turns', () => {
    const calibrator = new TokenRatioCalibrator();
    for (let i = 0; i < 25; i++) calibrator.observe('m', 1000, 400);
    expect(calibrator.tokensPerChar('m')).toBeCloseTo(0.4, 2);
  });

  it('keeps densities separate per model', () => {
    const calibrator = new TokenRatioCalibrator();
    calibrator.observe('dense', 1000, 800);
    calibrator.observe('sparse', 1000, 200);
    expect(calibrator.tokensPerChar('dense')).toBeCloseTo(0.8, 10);
    expect(calibrator.tokensPerChar('sparse')).toBeCloseTo(0.2, 10);
    expect(calibrator.tokensPerChar('unseen')).toBe(FALLBACK_TOKENS_PER_CHAR);
  });

  it('ignores samples too small to carry a density', () => {
    const calibrator = new TokenRatioCalibrator();
    calibrator.observe('m', 199, 100);
    expect(calibrator.observedTokensPerChar('m')).toBeUndefined();
  });

  it('rejects implausible densities rather than letting them skew the estimate', () => {
    const calibrator = new TokenRatioCalibrator();

    // Above one token per character: the prompt billed tokens with no
    // character footprint (media), so the ratio does not describe text.
    calibrator.observe('above', 1000, 1001);
    expect(calibrator.observedTokensPerChar('above')).toBeUndefined();

    // Below a tenth of a token per character: not a text-token ratio either.
    calibrator.observe('below', 1000, 99);
    expect(calibrator.observedTokensPerChar('below')).toBeUndefined();

    // Exactly on the bounds is still usable.
    calibrator.observe('edge-high', 1000, 1000);
    expect(calibrator.observedTokensPerChar('edge-high')).toBeCloseTo(1, 10);
    calibrator.observe('edge-low', 1000, 100);
    expect(calibrator.observedTokensPerChar('edge-low')).toBeCloseTo(0.1, 10);
  });

  it('ignores unusable counts instead of producing a non-finite density', () => {
    const calibrator = new TokenRatioCalibrator();
    calibrator.observe('m', 1000, 0);
    calibrator.observe('m', 1000, -5);
    calibrator.observe('m', 0, 100);
    calibrator.observe('m', Number.NaN, 100);
    calibrator.observe('m', 1000, Number.NaN);
    calibrator.observe('m', Number.POSITIVE_INFINITY, 100);
    expect(calibrator.observedTokensPerChar('m')).toBeUndefined();
    expect(calibrator.tokensPerChar('m')).toBe(FALLBACK_TOKENS_PER_CHAR);
  });

  it('never lets a rejected sample discard an already-good density', () => {
    const calibrator = new TokenRatioCalibrator();
    calibrator.observe('m', 1000, 500);
    calibrator.observe('m', 1000, 5000); // implausible: media-bearing turn
    expect(calibrator.tokensPerChar('m')).toBeCloseTo(0.5, 10);
  });
});
