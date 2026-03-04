import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AxlError,
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  ToolDenied,
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
