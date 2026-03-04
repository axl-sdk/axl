import type { ZodError } from 'zod';
import type { Result } from './types.js';

/** Base error class for all Axl errors */
export class AxlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AxlError';
    this.code = code;
  }
}

/** Thrown when schema validation fails after all retries exhausted */
export class VerifyError extends AxlError {
  readonly lastOutput: unknown;
  readonly zodError: ZodError;
  readonly retries: number;

  constructor(lastOutput: unknown, zodError: ZodError, retries: number) {
    super('VERIFY_ERROR', `Schema validation failed after ${retries} retries: ${zodError.message}`);
    this.name = 'VerifyError';
    this.lastOutput = lastOutput;
    this.zodError = zodError;
    this.retries = retries;
  }
}

/** Thrown when quorum is not met in spawn */
export class QuorumNotMet extends AxlError {
  readonly results: Result<unknown>[];

  constructor(required: number, actual: number, results: Result<unknown>[]) {
    super('QUORUM_NOT_MET', `Quorum not met: needed ${required} successes, got ${actual}`);
    this.name = 'QuorumNotMet';
    this.results = results;
  }
}

/** Thrown when vote cannot reach consensus */
export class NoConsensus extends AxlError {
  constructor(reason: string) {
    super('NO_CONSENSUS', `No consensus: ${reason}`);
    this.name = 'NoConsensus';
  }
}

/** Thrown when an operation exceeds its timeout */
export class TimeoutError extends AxlError {
  constructor(operation: string, timeoutMs: number) {
    super('TIMEOUT', `${operation} exceeded timeout of ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Thrown when a budget limit is exceeded */
export class BudgetExceededError extends AxlError {
  readonly limit: number;
  readonly spent: number;
  readonly policy: string;

  constructor(limit: number, spent: number, policy: string) {
    super(
      'BUDGET_EXCEEDED',
      `Budget exceeded: spent $${spent.toFixed(4)} of $${limit.toFixed(4)} limit (policy: ${policy})`,
    );
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.spent = spent;
    this.policy = policy;
  }
}

/** Thrown when an agent exceeds its maximum number of tool-calling turns */
export class MaxTurnsError extends AxlError {
  readonly maxTurns: number;

  constructor(operation: string, maxTurns: number) {
    super('MAX_TURNS', `${operation} exceeded maximum of ${maxTurns} turns`);
    this.name = 'MaxTurnsError';
    this.maxTurns = maxTurns;
  }
}

/** Thrown when a guardrail blocks a request/response and the policy is 'throw'. */
export class GuardrailError extends AxlError {
  readonly guardrailType: 'input' | 'output';
  readonly reason: string;

  constructor(guardrailType: 'input' | 'output', reason: string) {
    super('GUARDRAIL_BLOCKED', `${guardrailType} guardrail blocked: ${reason}`);
    this.name = 'GuardrailError';
    this.guardrailType = guardrailType;
    this.reason = reason;
  }
}

/** Internal: thrown when an agent tries to call a tool not in its ACL */
export class ToolDenied extends AxlError {
  readonly toolName: string;
  readonly agentName: string;

  constructor(toolName: string, agentName: string) {
    super(
      'TOOL_DENIED',
      `Agent "${agentName}" attempted to call tool "${toolName}" which is not in its ACL`,
    );
    this.name = 'ToolDenied';
    this.toolName = toolName;
    this.agentName = agentName;
  }
}
