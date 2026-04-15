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

/**
 * Format a cost for human-readable error messages. Uses tiered precision
 * so sub-cent costs (semantic memory embedder calls, cached responses,
 * free-tier models) don't collapse to `$0.0000`. Mirrors the Studio
 * client's `formatCost` utility so users see consistent numbers.
 *
 * Sign: negative values prefix `-` before the `$`, so `-1.50` renders
 * as `-$1.50` (not `$-1.50`). Negative costs aren't physically
 * meaningful but a budget accounting bug could produce them, and we
 * want those to be visibly wrong instead of hidden behind formatting.
 *
 * Non-finite: `NaN` and `±Infinity` are fail-loud signals that
 * something is broken in cost accounting — we preserve them literally
 * (`$NaN`, `$Infinity`, `-$Infinity`) so users see the bug in the
 * error message rather than a misleading `$0.00`.
 *
 * Tiers (for finite, non-zero values):
 *   `|cost| < $0.000001` (noise)  → `< $0.000001` (or `-< $0.000001`)
 *   `|cost| < $0.0001`            → scientific, e.g. `$1.5e-7`
 *   `|cost| < $0.01`              → 6 decimals, e.g. `$0.000095`
 *   `|cost| >= $0.01`             → 2 decimals, e.g. `$1.23`
 */
function formatBudgetCost(cost: number): string {
  // Fail-loud on non-finite: `NaN` / `Infinity` reaching this function
  // almost certainly means a cost-accounting bug, and collapsing them
  // to `$0.00` would hide the signal in the error message.
  if (Number.isNaN(cost)) return '$NaN';
  if (cost === Infinity) return '$Infinity';
  if (cost === -Infinity) return '-$Infinity';
  if (cost === 0) return '$0.00';

  const sign = cost < 0 ? '-' : '';
  const abs = Math.abs(cost);
  if (abs < 0.000001) return `${sign}< $0.000001`;
  if (abs < 0.0001) {
    const [mantissa, exponent] = abs.toExponential(2).split('e');
    return `${sign}$${mantissa}e${parseInt(exponent, 10)}`;
  }
  if (abs < 0.01) return `${sign}$${abs.toFixed(6)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Thrown when a budget limit is exceeded */
export class BudgetExceededError extends AxlError {
  readonly limit: number;
  readonly spent: number;
  readonly policy: string;

  constructor(limit: number, spent: number, policy: string) {
    super(
      'BUDGET_EXCEEDED',
      `Budget exceeded: spent ${formatBudgetCost(spent)} of ${formatBudgetCost(
        limit,
      )} limit (policy: ${policy})`,
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

/** Thrown when post-schema business rule validation fails after all retries exhausted */
export class ValidationError extends AxlError {
  readonly lastOutput: unknown;
  readonly reason: string;
  readonly retries: number;

  constructor(lastOutput: unknown, reason: string, retries: number) {
    super('VALIDATION_ERROR', `Validation failed after ${retries} retries: ${reason}`);
    this.name = 'ValidationError';
    this.lastOutput = lastOutput;
    this.reason = reason;
    this.retries = retries;
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
