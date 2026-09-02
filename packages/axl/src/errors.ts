import type { ZodError } from 'zod';
import type { Result, ToolFailureOptions } from './types.js';

/** Base error class for all Axl errors */
export class AxlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AxlError';
    this.code = code;
  }
}

/** Thrown when the public logical model-input shape is malformed. */
export class InvalidModelInputError extends AxlError {
  constructor(message: string) {
    super('INVALID_MODEL_INPUT', message);
    this.name = 'InvalidModelInputError';
  }
}

/** Thrown before dispatch when a provider/model cannot accept a rich input. */
export class UnsupportedModelInputError extends AxlError {
  readonly provider: string;
  readonly model: string;
  readonly modality: string;
  readonly source?: string;

  constructor(options: {
    provider: string;
    model: string;
    modality: string;
    source?: string;
    feature?: string;
  }) {
    super(
      'UNSUPPORTED_MODEL_INPUT',
      `Provider '${options.provider}' model '${options.model}' does not support ${options.feature ?? options.modality}${options.source ? ` from ${options.source}` : ''}`,
    );
    this.name = 'UnsupportedModelInputError';
    this.provider = options.provider;
    this.model = options.model;
    this.modality = options.modality;
    this.source = options.source;
  }
}

/** Thrown when the public transcription request contains unsupported or unsafe input. */
export class InvalidTranscriptionInputError extends AxlError {
  constructor(message: string) {
    super('INVALID_TRANSCRIPTION_INPUT', message);
    this.name = 'InvalidTranscriptionInputError';
  }
}

/** Thrown before dispatch when no explicit transcription adapter can serve a URI. */
export class UnsupportedTranscriptionInputError extends AxlError {
  readonly provider: string;
  readonly model: string;

  constructor(options: { provider: string; model: string; feature?: string }) {
    super(
      'UNSUPPORTED_TRANSCRIPTION_INPUT',
      `Transcription provider '${options.provider}'${options.model ? ` model '${options.model}'` : ''} does not support ${options.feature ?? 'this request'}`,
    );
    this.name = 'UnsupportedTranscriptionInputError';
    this.provider = options.provider;
    this.model = options.model;
  }
}

/** Safe boundary error for an adapter failure. The original provider error is
 * retained only as a non-enumerable cause because vendor messages/bodies may
 * echo raw audio or provider-file references. */
export class TranscriptionOperationError extends AxlError {
  readonly provider: string;
  readonly model: string;
  readonly usage?: {
    audioSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
  };
  readonly pricingStatus?: 'priced' | 'unpriced' | 'zero';
  readonly cleanupStatus?: 'not_required' | 'deleted' | 'failed' | 'timed_out';
  /** Safe HTTP diagnostics projected from ProviderError when available. */
  readonly status?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  declare readonly cause?: unknown;

  constructor(options: {
    provider: string;
    model: string;
    usage?: {
      audioSeconds?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cost?: number;
    };
    pricingStatus?: 'priced' | 'unpriced' | 'zero';
    cleanupStatus?: 'not_required' | 'deleted' | 'failed' | 'timed_out';
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super('TRANSCRIPTION_PROVIDER_ERROR', 'Transcription provider operation failed');
    this.name = 'TranscriptionOperationError';
    this.provider = options.provider;
    this.model = options.model;
    this.usage = options.usage;
    this.pricingStatus = options.pricingStatus;
    this.cleanupStatus = options.cleanupStatus;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    if (options.cause !== undefined)
      Object.defineProperty(this, 'cause', { enumerable: false, value: options.cause });
  }
}

/**
 * Strict observation overflow. Kept in the shared error module so every
 * recovery boundary can identify the same non-recoverable control error.
 * Thrown at the producer when an event queue configured with
 * `onOverflow: 'throw'` exceeds `maxQueued`.
 */
export class EventStreamOverflowError extends Error {
  readonly maxQueued: number;
  readonly eventType: string;
  declare readonly cause?: unknown;

  constructor(maxQueued: number, eventType: string, cause?: unknown) {
    super(
      `AxlEventBus queue exceeded maxQueued=${maxQueued} (event type: ${eventType}). ` +
        `Consumer is too slow or the producer is unbounded. Configure ` +
        `\`maxQueued\`/\`onOverflow\` on the runtime, or set maxQueued: Infinity to disable.`,
    );
    this.name = 'EventStreamOverflowError';
    this.maxQueued = maxQueued;
    this.eventType = eventType;
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export function isEventStreamOverflowError(error: unknown): error is EventStreamOverflowError {
  return error instanceof EventStreamOverflowError;
}

/** Re-throw strict observation overflow before a recovery boundary can
 * reinterpret it as an ordinary application failure. */
export function rethrowEventStreamOverflow(error: unknown): void {
  if (isEventStreamOverflowError(error)) throw error;
}

/** Preserve the application failure displaced by a stricter terminal error. */
export function preserveErrorCause<T extends Error>(error: T, cause: unknown): T {
  if (cause === undefined || cause === error || 'cause' in error) return error;
  Object.defineProperty(error, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
  });
  return error;
}

/** A known tool failure whose author-provided model message is safe to expose. */
export class ToolFailure extends AxlError {
  readonly modelMessage: string;
  declare readonly cause?: unknown;

  constructor(options: ToolFailureOptions) {
    super(options.code ?? 'TOOL_FAILURE', options.message);
    this.name = 'ToolFailure';
    this.modelMessage = options.modelMessage;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
      });
    }
  }
}

export type ToolFailureConstructor = typeof ToolFailure;

/** Thrown when a tool's model-facing output cannot be projected safely. */
export class ToolModelOutputError extends AxlError {
  readonly toolName: string;
  readonly cause: unknown;

  constructor(toolName: string, cause: unknown) {
    super('TOOL_MODEL_OUTPUT_ERROR', `Failed to prepare model output for tool "${toolName}"`);
    this.name = 'ToolModelOutputError';
    this.toolName = toolName;
    this.cause = cause;
    // Mapper errors may contain application data. Keep the cause directly
    // inspectable by trusted host code without exposing it through ordinary
    // Object.keys()/JSON.stringify() error serialization.
    Object.defineProperty(this, 'cause', { enumerable: false });
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
