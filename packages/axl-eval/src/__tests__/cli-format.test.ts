import { describe, it, expect } from 'vitest';
import { formatModelTimingLines } from '../cli-format.js';
import type { ModelTimingStats } from '../types.js';

/** A model with a long tail: most calls are slow, one was fast. Per-call
 *  sampling gives a mean of 910ms and a p95 of 1000ms — the pair the row prints. */
const UNEVEN: ModelTimingStats = {
  calls: 10,
  wireMs: { mean: 910, min: 100, max: 1000, p50: 1000, p95: 1000 },
  queuedMs: { mean: 38, min: 38, max: 38, p50: 38, p95: 38 },
  retryMs: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 },
};

describe('formatModelTimingLines()', () => {
  it('renders nothing when the run reported no per-model timing', () => {
    expect(formatModelTimingLines(undefined, 8)).toEqual([]);
    expect(formatModelTimingLines({}, 8)).toEqual([]);
  });

  it('pairs the per-call mean with the p95 so a tail is visible', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);

    // Every figure on the row is per call, so the count can be read beside them
    // without inviting a wrong division.
    expect(line).toContain('wire 910ms/1000ms');
    expect(line).toContain('(10 calls, mean/p95 per call)');
  });

  it('labels every figure with its unit so it cannot be read as seconds', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);

    // The wall-clock Timing row directly above renders seconds. Sub-second
    // per-call latencies would collapse to "0.0s" there, so these must be ms
    // and must say so.
    expect(line).toMatch(/wire 910ms\/1000ms/);
    expect(line).toMatch(/queued 38ms/);
    expect(line).toMatch(/retries 0ms/);
    expect(line).not.toMatch(/\d+\.\ds/);
  });

  it('prints queued and retries as a mean only, keeping the row readable', () => {
    // These describe Axl's own limiter and the provider's throttling, not the
    // model, so a p95 would lengthen every row without changing a model choice.
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);
    expect(line).toContain('queued 38ms ·');
    expect(line).not.toContain('queued 38ms/');
    expect(line).not.toContain('retries 0ms/');
  });

  it('shows first-token latency only when a call actually streamed one', () => {
    const streamed: ModelTimingStats = {
      ...UNEVEN,
      firstTokenMs: { mean: 180, min: 90, max: 400, p50: 170, p95: 400 },
      firstTokenCalls: 10,
    };

    expect(formatModelTimingLines({ 'openai:gpt-4o': streamed }, 8)[0]).toContain(
      'first token 180ms/400ms',
    );
    // A non-streaming model must show no first-token figure at all — a `0ms`
    // would read as an instantly-responding model in a J2 comparison.
    expect(formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8)[0]).not.toContain('first token');
  });

  it('surfaces retry time so provider throttling is visible', () => {
    const throttled: ModelTimingStats = {
      ...UNEVEN,
      retryMs: { mean: 2400, min: 0, max: 9000, p50: 1200, p95: 9000 },
    };
    expect(formatModelTimingLines({ 'anthropic:claude': throttled }, 8)[0]).toContain(
      'retries 2400ms',
    );
  });

  it('renders one line per model, in order, naming each model', () => {
    const lines = formatModelTimingLines(
      { 'openai:gpt-4o': UNEVEN, 'anthropic:claude-sonnet-4-6': UNEVEN },
      8,
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('openai:gpt-4o');
    expect(lines[1]).toContain('anthropic:claude-sonnet-4-6');
    // Model names are never truncated to the scorer column, however narrow it is.
    expect(formatModelTimingLines({ 'anthropic:claude-sonnet-4-6': UNEVEN }, 2)[0]).toContain(
      'anthropic:claude-sonnet-4-6',
    );
  });

  it('singularizes a one-call model', () => {
    const single: ModelTimingStats = { ...UNEVEN, calls: 1 };
    expect(formatModelTimingLines({ 'openai:gpt-4o': single }, 8)[0]).toContain(
      '(1 call, mean/p95 per call)',
    );
  });

  it('indents under the scorer-name column so it reads as a sub-row of Timing', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);
    expect(line.startsWith('    openai:gpt-4o')).toBe(true);
  });
});
