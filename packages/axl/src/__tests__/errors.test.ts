import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AxlError,
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  ToolDenied,
  BudgetExceededError,
} from '../errors.js';

describe('AxlError', () => {
  it('has code and message', () => {
    const err = new AxlError('TEST_ERROR', 'Something went wrong');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.message).toBe('Something went wrong');
  });

  it('has name set to AxlError', () => {
    const err = new AxlError('TEST', 'test');
    expect(err.name).toBe('AxlError');
  });

  it('extends Error', () => {
    const err = new AxlError('TEST', 'test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has a stack trace', () => {
    const err = new AxlError('TEST', 'test');
    expect(err.stack).toBeDefined();
  });
});

describe('VerifyError', () => {
  it('stores lastOutput, zodError, and retries', () => {
    const schema = z.object({ name: z.string() });
    let zodError: z.ZodError;
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      zodError = e as z.ZodError;
    }

    const err = new VerifyError('invalid output', zodError!, 3);
    expect(err.lastOutput).toBe('invalid output');
    expect(err.zodError).toBe(zodError!);
    expect(err.retries).toBe(3);
  });

  it('has code VERIFY_ERROR', () => {
    const zodError = new z.ZodError([]);
    const err = new VerifyError(null, zodError, 0);
    expect(err.code).toBe('VERIFY_ERROR');
  });

  it('has descriptive message mentioning retries', () => {
    const zodError = new z.ZodError([]);
    const err = new VerifyError(null, zodError, 5);
    expect(err.message).toContain('5 retries');
  });

  it('has name set to VerifyError', () => {
    const zodError = new z.ZodError([]);
    const err = new VerifyError(null, zodError, 0);
    expect(err.name).toBe('VerifyError');
  });

  it('extends AxlError', () => {
    const zodError = new z.ZodError([]);
    const err = new VerifyError(null, zodError, 0);
    expect(err).toBeInstanceOf(AxlError);
  });

  it('extends Error', () => {
    const zodError = new z.ZodError([]);
    const err = new VerifyError(null, zodError, 0);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('QuorumNotMet', () => {
  it('stores results', () => {
    const results = [
      { ok: true as const, value: 'a' },
      { ok: false as const, error: 'failed' },
    ];
    const err = new QuorumNotMet(2, 1, results);
    expect(err.results).toBe(results);
  });

  it('has code QUORUM_NOT_MET', () => {
    const err = new QuorumNotMet(3, 1, []);
    expect(err.code).toBe('QUORUM_NOT_MET');
  });

  it('has descriptive message mentioning required and actual', () => {
    const err = new QuorumNotMet(3, 1, []);
    expect(err.message).toContain('needed 3');
    expect(err.message).toContain('got 1');
  });

  it('has name set to QuorumNotMet', () => {
    const err = new QuorumNotMet(2, 1, []);
    expect(err.name).toBe('QuorumNotMet');
  });

  it('extends AxlError', () => {
    const err = new QuorumNotMet(2, 1, []);
    expect(err).toBeInstanceOf(AxlError);
  });
});

describe('NoConsensus', () => {
  it('has reason in message', () => {
    const err = new NoConsensus('values differ');
    expect(err.message).toContain('values differ');
    expect(err.message).toContain('No consensus');
  });

  it('has code NO_CONSENSUS', () => {
    const err = new NoConsensus('test');
    expect(err.code).toBe('NO_CONSENSUS');
  });

  it('has name set to NoConsensus', () => {
    const err = new NoConsensus('test');
    expect(err.name).toBe('NoConsensus');
  });

  it('extends AxlError', () => {
    const err = new NoConsensus('test');
    expect(err).toBeInstanceOf(AxlError);
  });
});

describe('TimeoutError', () => {
  it('has operation and timeout info in message', () => {
    const err = new TimeoutError('ctx.ask()', 30000);
    expect(err.message).toContain('ctx.ask()');
    expect(err.message).toContain('30000ms');
  });

  it('has code TIMEOUT', () => {
    const err = new TimeoutError('test', 5000);
    expect(err.code).toBe('TIMEOUT');
  });

  it('has name set to TimeoutError', () => {
    const err = new TimeoutError('test', 5000);
    expect(err.name).toBe('TimeoutError');
  });

  it('extends AxlError', () => {
    const err = new TimeoutError('test', 5000);
    expect(err).toBeInstanceOf(AxlError);
  });
});

describe('ToolDenied', () => {
  it('has toolName and agentName', () => {
    const err = new ToolDenied('dangerous_tool', 'Agent_1');
    expect(err.toolName).toBe('dangerous_tool');
    expect(err.agentName).toBe('Agent_1');
  });

  it('has descriptive message', () => {
    const err = new ToolDenied('rm_rf', 'Agent_2');
    expect(err.message).toContain('rm_rf');
    expect(err.message).toContain('Agent_2');
    expect(err.message).toContain('ACL');
  });

  it('has code TOOL_DENIED', () => {
    const err = new ToolDenied('test', 'agent');
    expect(err.code).toBe('TOOL_DENIED');
  });

  it('has name set to ToolDenied', () => {
    const err = new ToolDenied('test', 'agent');
    expect(err.name).toBe('ToolDenied');
  });

  it('extends AxlError', () => {
    const err = new ToolDenied('test', 'agent');
    expect(err).toBeInstanceOf(AxlError);
  });

  it('extends Error', () => {
    const err = new ToolDenied('test', 'agent');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('BudgetExceededError', () => {
  it('formats 2-decimal values normally', () => {
    const err = new BudgetExceededError(10, 12.5, 'hard_stop');
    expect(err.message).toBe('Budget exceeded: spent $12.50 of $10.00 limit (policy: hard_stop)');
  });

  it('formats sub-cent values in [0.0001, 0.01) with 6 decimals', () => {
    const err = new BudgetExceededError(0.005, 0.008, 'finish_and_stop');
    expect(err.message).toContain('$0.008000');
    expect(err.message).toContain('$0.005000');
  });

  it('formats values in [1e-6, 1e-4) with scientific notation', () => {
    const err = new BudgetExceededError(5e-5, 8e-5, 'hard_stop');
    // Inside the scientific tier: `$8.00e-5` and `$5.00e-5`
    expect(err.message).toContain('e-5');
    expect(err.message).toContain('$8.00e-5');
  });

  it('formats noise-level values (< 1e-6) with the < sentinel', () => {
    const err = new BudgetExceededError(1e-7, 5e-8, 'warn');
    expect(err.message).toContain('< $0.000001');
  });

  it('preserves cost numbers on the error instance', () => {
    const err = new BudgetExceededError(0.5, 0.75, 'hard_stop');
    expect(err.limit).toBe(0.5);
    expect(err.spent).toBe(0.75);
    expect(err.policy).toBe('hard_stop');
  });

  it('places the minus sign outside the dollar sign for negative values', () => {
    // Shouldn't happen in practice — cost is always non-negative — but a
    // cost-accounting bug could produce a negative value, and we want
    // the error message to render it cleanly as `-$X` instead of `$-X`.
    const err = new BudgetExceededError(1, -2.5, 'hard_stop');
    expect(err.message).toContain('-$2.50');
    expect(err.message).not.toContain('$-2.50');
  });

  it('renders NaN/Infinity literally to preserve the bug signal', () => {
    // Collapsing NaN/Infinity to $0.00 would hide a cost-accounting bug
    // behind the error message. Fail-loud.
    const nanErr = new BudgetExceededError(10, NaN, 'hard_stop');
    expect(nanErr.message).toContain('$NaN');
    const infErr = new BudgetExceededError(10, Infinity, 'hard_stop');
    expect(infErr.message).toContain('$Infinity');
    const negInfErr = new BudgetExceededError(10, -Infinity, 'hard_stop');
    expect(negInfErr.message).toContain('-$Infinity');
  });

  it('extends AxlError with code BUDGET_EXCEEDED', () => {
    const err = new BudgetExceededError(1, 2, 'hard_stop');
    expect(err).toBeInstanceOf(AxlError);
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.name).toBe('BudgetExceededError');
  });
});
