import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEval } from '../define-eval.js';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';

describe('defineEval()', () => {
  it('returns the config as-is (identity function)', () => {
    const ds = dataset({
      name: 'test-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'What is 1+1?' } }],
    });

    const sc = scorer({
      name: 'exact',
      description: 'Exact match',
      score: () => 1,
    });

    const config = {
      workflow: 'test-workflow',
      dataset: ds,
      scorers: [sc],
      concurrency: 3,
      metadata: { version: '1.0' },
    };

    const result = defineEval(config);

    expect(result).toBe(config);
    expect(result.workflow).toBe('test-workflow');
    expect(result.dataset).toBe(ds);
    expect(result.scorers).toEqual([sc]);
    expect(result.concurrency).toBe(3);
    expect(result.metadata).toEqual({ version: '1.0' });
  });

  it('accepts minimal config with required fields only', () => {
    const ds = dataset({
      name: 'minimal-ds',
      schema: z.object({ q: z.string() }),
      items: [],
    });

    const sc = scorer({
      name: 'test',
      description: 'test',
      score: () => 0,
    });

    const config = {
      workflow: 'minimal',
      dataset: ds,
      scorers: [sc],
    };

    const result = defineEval(config);

    expect(result).toBe(config);
    expect(result.workflow).toBe('minimal');
    expect(result.concurrency).toBeUndefined();
    expect(result.metadata).toBeUndefined();
    expect(result.budget).toBeUndefined();
  });

  it('preserves budget and all optional fields', () => {
    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [],
    });

    const sc = scorer({
      name: 'sc',
      description: 'sc',
      score: () => 1,
    });

    const config = {
      workflow: 'w',
      dataset: ds,
      scorers: [sc],
      concurrency: 10,
      budget: '$5.00',
      metadata: { env: 'staging' },
    };

    const result = defineEval(config);

    expect(result.budget).toBe('$5.00');
    expect(result.concurrency).toBe(10);
    expect(result.metadata).toEqual({ env: 'staging' });
  });
});
