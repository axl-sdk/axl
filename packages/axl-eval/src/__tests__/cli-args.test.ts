import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEvalArgs, envInt, KNOWN_FLAGS } from '../cli-args.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AXL_EVAL_CONCURRENCY;
});

describe('parseEvalArgs()', () => {
  it('parses paths and defaults', () => {
    const parsed = parseEvalArgs(['evals/foo.eval.ts']);
    expect(parsed.paths).toEqual(['evals/foo.eval.ts']);
    expect(parsed.runs).toBe(1);
    expect(parsed.captureTraces).toBe(false);
    expect(parsed.concurrency).toBeUndefined();
    expect(parsed.scorerNames).toBeUndefined();
  });

  it('parses --concurrency as a number', () => {
    expect(parseEvalArgs(['f', '--concurrency', '3']).concurrency).toBe(3);
  });

  it('clamps invalid --concurrency to 1 with a warning (no exit)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseEvalArgs(['f', '--concurrency', '0']).concurrency).toBe(1);
    expect(parseEvalArgs(['f', '--concurrency', 'abc']).concurrency).toBe(1);
    expect(parseEvalArgs(['f', '--concurrency', '-2']).concurrency).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('parses --scorers into a deduped, trimmed, first-seen-order list', () => {
    expect(parseEvalArgs(['f', '--scorers', 'a,b']).scorerNames).toEqual(['a', 'b']);
    expect(parseEvalArgs(['f', '--scorers', ' a , b ,']).scorerNames).toEqual(['a', 'b']);
    expect(parseEvalArgs(['f', '--scorers', 'a,a,b']).scorerNames).toEqual(['a', 'b']);
  });

  it('keeps --capture-traces as a boolean and consumes no value', () => {
    const parsed = parseEvalArgs(['--capture-traces', 'f']);
    expect(parsed.captureTraces).toBe(true);
    expect(parsed.paths).toEqual(['f']);
  });

  it('exits when a value flag is missing its value', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseEvalArgs(['f', '--concurrency'])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits on an unknown flag', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseEvalArgs(['f', '--nope'])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('lists --concurrency and --scorers among the known flags', () => {
    expect(KNOWN_FLAGS.has('--concurrency')).toBe(true);
    expect(KNOWN_FLAGS.has('--scorers')).toBe(true);
  });
});

describe('envInt()', () => {
  it('reads a positive integer', () => {
    process.env.AXL_EVAL_CONCURRENCY = '8';
    expect(envInt('AXL_EVAL_CONCURRENCY')).toBe(8);
  });

  it('returns undefined for absent / non-numeric / <= 0 values', () => {
    expect(envInt('AXL_EVAL_CONCURRENCY')).toBeUndefined();
    process.env.AXL_EVAL_CONCURRENCY = 'abc';
    expect(envInt('AXL_EVAL_CONCURRENCY')).toBeUndefined();
    process.env.AXL_EVAL_CONCURRENCY = '0';
    expect(envInt('AXL_EVAL_CONCURRENCY')).toBeUndefined();
    process.env.AXL_EVAL_CONCURRENCY = '-3';
    expect(envInt('AXL_EVAL_CONCURRENCY')).toBeUndefined();
  });
});
