import { describe, it, expect } from 'vitest';
import { formatModelTimingLines } from '../cli-format.js';
import type { ModelTimingStats } from '../types.js';

/** A model whose per-item distribution diverges sharply from its call-weighted
 *  mean — the shape that made the original rendering misleading. */
const UNEVEN: ModelTimingStats = {
  calls: 10,
  meanWireMs: 910,
  meanQueuedMs: 38,
  meanRetryMs: 0,
  wireMs: { mean: 550, min: 100, max: 1000, p50: 1000, p95: 1000 },
  queuedMs: { mean: 38, min: 38, max: 38, p50: 38, p95: 38 },
};

describe('formatModelTimingLines()', () => {
  it('renders nothing when the run reported no per-model timing', () => {
    expect(formatModelTimingLines(undefined, 8)).toEqual([]);
    expect(formatModelTimingLines({}, 8)).toEqual([]);
  });

  it('prints the call-weighted mean, never the per-item distribution', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);

    // 910 is the true per-call mean; 550 is the per-item-sampled one. Printing
    // 550 beside "10 calls" invites dividing one by the other and choosing the
    // wrong model, which is the whole reason both figures exist separately.
    expect(line).toContain('wire 910ms');
    expect(line).not.toContain('550');
    expect(line).toContain('(10 calls, mean per call)');
  });

  it('labels every figure with its unit so it cannot be read as seconds', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);

    // The wall-clock Timing row directly above renders seconds. Sub-second
    // per-call latencies would collapse to "0.0s" there, so these must be ms
    // and must say so.
    expect(line).toMatch(/wire 910ms/);
    expect(line).toMatch(/queued 38ms/);
    expect(line).toMatch(/retries 0ms/);
    expect(line).not.toMatch(/\d+\.\ds/);
  });

  it('shows first-token latency only when a call actually streamed one', () => {
    const streamed: ModelTimingStats = {
      ...UNEVEN,
      meanFirstTokenMs: 180,
      firstTokenCalls: 10,
    };

    expect(formatModelTimingLines({ 'openai:gpt-4o': streamed }, 8)[0]).toContain(
      'first token 180ms',
    );
    // A non-streaming model must show no first-token figure at all — a `0ms`
    // would read as an instantly-responding model in a J2 comparison.
    expect(formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8)[0]).not.toContain('first token');
  });

  it('surfaces retry time so provider throttling is visible', () => {
    const throttled: ModelTimingStats = { ...UNEVEN, meanRetryMs: 2400 };
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
      '(1 call, mean per call)',
    );
  });

  it('indents under the scorer-name column so it reads as a sub-row of Timing', () => {
    const [line] = formatModelTimingLines({ 'openai:gpt-4o': UNEVEN }, 8);
    expect(line.startsWith('    openai:gpt-4o')).toBe(true);
  });
});
