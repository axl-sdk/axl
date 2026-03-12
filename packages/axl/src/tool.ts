import type { z } from 'zod';
import type { WorkflowContext } from './context.js';

/** Retry policy for tool handlers */
export type RetryPolicy = {
  attempts?: number;
  backoff?: 'none' | 'linear' | 'exponential';
  on?: (error: Error & { status?: number }) => boolean;
};

/** Lifecycle hooks for tool execution. */
export type ToolHooks<TInput = unknown, TOutput = unknown> = {
  /** Transform input before the handler runs. Receives parsed input and workflow context. */
  before?(input: TInput, ctx: WorkflowContext): TInput | Promise<TInput>;
  /** Transform output after the handler runs. Receives handler result and workflow context. */
  after?(output: TOutput, ctx: WorkflowContext): TOutput | Promise<TOutput>;
};

/** Tool configuration */
export type ToolConfig<TInput extends z.ZodTypeAny, TOutput = unknown> = {
  name: string;
  description: string;
  input: TInput;
  handler: (input: z.infer<TInput>, ctx: WorkflowContext) => TOutput | Promise<TOutput>;
  retry?: RetryPolicy;
  sensitive?: boolean;
  /** Maximum string length for any string argument. Default: 10000. Set to 0 to disable. */
  maxStringLength?: number;
  /** When true, agent-initiated calls trigger ctx.awaitHuman() before execution. */
  requireApproval?: boolean;
  /** Lifecycle hooks: before/after the handler. */
  hooks?: ToolHooks<z.infer<TInput>, TOutput>;
};

/** A defined tool instance */
export type Tool<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly sensitive: boolean;
  readonly retry: RetryPolicy;
  readonly requireApproval: boolean;
  readonly hooks?: ToolHooks<z.infer<TInput>, TOutput>;
  /** Run the tool directly from workflow code */
  run(ctx: WorkflowContext, input: z.infer<TInput>): Promise<TOutput>;
  /** Execute the handler (internal use — includes retry logic) */
  _execute(input: z.infer<TInput>, ctx?: WorkflowContext): Promise<TOutput>;
};

const DEFAULT_MAX_STRING_LENGTH = 10_000;

/**
 * Recursively validate string lengths in parsed tool arguments.
 * Throws if any string exceeds the configured max length.
 */
function validateStringLengths(value: unknown, maxLen: number, path = ''): void {
  if (typeof value === 'string') {
    if (value.length > maxLen) {
      throw new Error(
        `String argument${path ? ` at "${path}"` : ''} exceeds maximum length (${value.length} > ${maxLen})`,
      );
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateStringLengths(value[i], maxLen, path ? `${path}[${i}]` : `[${i}]`);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      validateStringLengths(val, maxLen, path ? `${path}.${key}` : key);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffMs(attempt: number, strategy: 'none' | 'linear' | 'exponential'): number {
  switch (strategy) {
    case 'none':
      return 0;
    case 'linear':
      return attempt * 1000;
    case 'exponential':
      return Math.pow(2, attempt - 1) * 1000;
  }
}

/**
 * Define a tool with Zod-validated input, a handler function, and optional retry policy.
 * @param config - Tool configuration: name, description, input schema, handler, retry, and sensitivity options.
 * @returns A Tool instance that can be attached to agents and invoked via `tool.run()` or agent tool calling.
 */
export function tool<TInput extends z.ZodTypeAny, TOutput = unknown>(
  config: ToolConfig<TInput, TOutput>,
): Tool<TInput, TOutput> {
  const retryPolicy: RetryPolicy = {
    attempts: config.retry?.attempts ?? 1,
    backoff: config.retry?.backoff ?? 'exponential',
    on: config.retry?.on,
  };

  const maxStringLen = config.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const execute = async (input: z.infer<TInput>, ctx?: WorkflowContext): Promise<TOutput> => {
    // Validate input against schema
    const parsed = config.input.parse(input);

    // Enforce string length limits
    if (maxStringLen > 0) {
      validateStringLengths(parsed, maxStringLen);
    }

    const maxAttempts = retryPolicy.attempts ?? 1;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // ctx is optional on _execute but required on handler. In practice, all runtime
        // call sites (agent tool loop, tool.run) always provide ctx. The undefined case
        // only occurs when _execute is called directly in tests or internal code.
        return await config.handler(parsed, ctx as WorkflowContext);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt === maxAttempts) break;

        // Check retry predicate
        if (retryPolicy.on && !retryPolicy.on(lastError as Error & { status?: number })) {
          break;
        }

        // Apply backoff
        const backoffMs = getBackoffMs(attempt, retryPolicy.backoff ?? 'exponential');
        if (backoffMs > 0) {
          await sleep(backoffMs);
        }
      }
    }

    throw lastError;
  };

  return {
    name: config.name,
    description: config.description,
    inputSchema: config.input,
    sensitive: config.sensitive ?? false,
    retry: retryPolicy,
    requireApproval: config.requireApproval ?? false,
    hooks: config.hooks,

    async run(ctx: WorkflowContext, input: z.infer<TInput>): Promise<TOutput> {
      const startTime = Date.now();
      try {
        // Apply before hook (no approval gate for direct workflow calls)
        let processedInput = input;
        if (config.hooks?.before) {
          processedInput = await config.hooks.before(processedInput, ctx);
        }

        let result = await execute(processedInput, ctx);

        // Apply after hook
        if (config.hooks?.after) {
          result = await config.hooks.after(result, ctx);
        }

        ctx.log('tool_call_complete', {
          tool: config.name,
          duration: Date.now() - startTime,
        });
        return result;
      } catch (err) {
        ctx.log('tool_call_error', {
          tool: config.name,
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - startTime,
        });
        throw err;
      }
    },

    _execute: execute,
  };
}
