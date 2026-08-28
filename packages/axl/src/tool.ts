import { ZodError, type z } from 'zod';
import type { WorkflowContext } from './context.js';
import { rethrowEventStreamOverflow } from './errors.js';
import type { ToolArgumentIssue } from './types.js';

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

/** JSON-compatible content that a tool may explicitly expose to the model. */
export type ToolModelOutput =
  | string
  | number
  | boolean
  | null
  | readonly ToolModelOutput[]
  | { readonly [key: string]: ToolModelOutput | undefined };

/** Tool configuration */
export type ToolConfig<TInput extends z.ZodType, TOutput = unknown> = {
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
  /** Select the subset of a successful result that is sent back to the model. */
  toModelOutput?(this: void, output: Readonly<TOutput>): ToolModelOutput;
};

/** A defined tool instance */
export type Tool<TInput extends z.ZodType = z.ZodType, TOutput = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly sensitive: boolean;
  readonly retry: RetryPolicy;
  readonly requireApproval: boolean;
  readonly hooks?: ToolHooks<z.infer<TInput>, TOutput>;
  /** Select the subset of a successful result that is sent back to the model. */
  toModelOutput?(this: void, output: Readonly<TOutput>): ToolModelOutput;
  /** Run the tool directly from workflow code */
  run(ctx: WorkflowContext, input: z.infer<TInput>): Promise<TOutput>;
  /** Execute the handler (internal use — includes retry logic) */
  _execute(input: z.infer<TInput>, ctx?: WorkflowContext): Promise<TOutput>;
};

const DEFAULT_MAX_STRING_LENGTH = 10_000;
const MAX_MODEL_ARGUMENT_ISSUES = 8;
const MAX_MODEL_ARGUMENT_MESSAGE_LENGTH = 2_000;
const MAX_MODEL_ARGUMENT_LINE_LENGTH = 220;
const MAX_MODEL_ARGUMENT_PATH_LENGTH = 160;
const MAX_UNION_DEPTH = 3;
const MAX_UNION_BRANCHES = 4;
const MAX_LITERAL_ALTERNATIVES = 10;

const SAFE_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'array',
  'object',
  'integer',
]);

const SAFE_STRING_FORMATS = new Set([
  'email',
  'url',
  'emoji',
  'uuid',
  'guid',
  'nanoid',
  'cuid',
  'cuid2',
  'ulid',
  'xid',
  'ksuid',
  'datetime',
  'date',
  'time',
  'duration',
  'ipv4',
  'ipv6',
  'cidrv4',
  'cidrv6',
  'base64',
  'base64url',
  'json_string',
  'e164',
  'lowercase',
  'uppercase',
  'jwt',
]);

function truncateModelFeedback(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

const DISPLAY_CONTROL_CHARACTERS = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g;

type JsonSchema = Record<string, unknown>;

type ResolvedSchemaPath = {
  node: JsonSchema;
  segments: string[];
};

function isJsonSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeDisplayControls(value: string): string {
  return value.replace(
    DISPLAY_CONTROL_CHARACTERS,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function quoteModelText(value: string): string {
  return escapeDisplayControls(JSON.stringify(value));
}

function schemaNumber(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function schemaLiteral(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const rendered = quoteModelText(value);
    return rendered.length <= 120 ? rendered : '"<literal omitted>"';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return undefined;
}

function schemaType(schema: JsonSchema): string | undefined {
  const type = schema.type;
  return typeof type === 'string' && SAFE_SCHEMA_TYPES.has(type) ? type : undefined;
}

function compositionBranches(schema: JsonSchema): JsonSchema[] {
  const branches: JsonSchema[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value.slice(0, MAX_UNION_BRANCHES)) {
      if (isJsonSchema(branch)) branches.push(branch);
    }
  }
  return branches;
}

function unionBranches(schema: JsonSchema): JsonSchema[] {
  const branches: JsonSchema[] = [];
  for (const key of ['anyOf', 'oneOf'] as const) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value.slice(0, MAX_UNION_BRANCHES)) {
      if (isJsonSchema(branch)) branches.push(branch);
    }
  }
  return branches;
}

function resolvePathSegment(
  schema: JsonSchema,
  segment: PropertyKey,
  depth = 0,
): { node: JsonSchema; renderedSegment: string } | undefined {
  if (depth >= MAX_UNION_DEPTH) return undefined;

  if (typeof segment === 'string') {
    const properties = schema.properties;
    if (isJsonSchema(properties) && Object.hasOwn(properties, segment)) {
      const child = properties[segment];
      if (isJsonSchema(child)) return { node: child, renderedSegment: segment };
    }
    if (isJsonSchema(schema.additionalProperties)) {
      return { node: schema.additionalProperties, renderedSegment: '<key>' };
    }
  } else if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
    const prefixItems = schema.prefixItems;
    if (Array.isArray(prefixItems) && isJsonSchema(prefixItems[segment])) {
      return { node: prefixItems[segment], renderedSegment: String(segment) };
    }
    if (isJsonSchema(schema.items)) {
      return { node: schema.items, renderedSegment: '<index>' };
    }
  }

  for (const branch of compositionBranches(schema)) {
    const resolved = resolvePathSegment(branch, segment, depth + 1);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveSchemaPath(
  providerVisibleSchema: unknown,
  issuePath: readonly PropertyKey[],
): ResolvedSchemaPath | undefined {
  if (!isJsonSchema(providerVisibleSchema)) return undefined;

  let node = providerVisibleSchema;
  const segments: string[] = [];
  for (const segment of issuePath) {
    const resolved = resolvePathSegment(node, segment);
    if (resolved === undefined) {
      segments.push('<path omitted>');
      return { node, segments };
    }
    node = resolved.node;
    segments.push(resolved.renderedSegment);
  }
  return { node, segments };
}

function jsonPointerPath(segments: readonly string[]): string {
  if (segments.length === 0) return '<root>';
  const pointer = `/${segments.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
  const rendered = quoteModelText(pointer);
  return rendered.length <= MAX_MODEL_ARGUMENT_PATH_LENGTH ? rendered : '"<path omitted>"';
}

function schemaAlternatives(schema: JsonSchema, depth = 0): string[] {
  if (depth >= MAX_UNION_DEPTH) return [];
  const constant = 'const' in schema ? schemaLiteral(schema.const) : undefined;
  if (constant !== undefined) return [constant];

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, MAX_LITERAL_ALTERNATIVES).map(schemaLiteral);
    if (values.every((value): value is string => value !== undefined)) return values;
  }

  const type = schemaType(schema);
  if (type !== undefined) return [type];

  const alternatives = unionBranches(schema).flatMap((branch) =>
    schemaAlternatives(branch, depth + 1),
  );
  return alternatives.slice(0, MAX_LITERAL_ALTERNATIVES);
}

function schemaEnumExpectation(schema: JsonSchema): string | undefined {
  if ('const' in schema) {
    const constant = schemaLiteral(schema.const);
    return constant === undefined ? undefined : `expected ${constant}`;
  }
  if (!Array.isArray(schema.enum)) return undefined;
  const values = schema.enum.slice(0, MAX_LITERAL_ALTERNATIVES).map(schemaLiteral);
  if (values.some((value) => value === undefined)) return undefined;
  const rendered = values as string[];
  if (rendered.length === 0) return undefined;
  const omission = schema.enum.length > rendered.length ? ', …' : '';
  return `expected ${rendered.length === 1 ? rendered[0] : `one of ${rendered.join(', ')}`}${omission}`;
}

function schemaTypeExpectation(schema: JsonSchema): string | undefined {
  const type = schemaType(schema);
  if (type !== undefined) return `expected ${type}`;
  const alternatives = schemaAlternatives(schema);
  return alternatives.length === 0 ? undefined : `expected one of: ${alternatives.join(', ')}`;
}

function schemaSizeExpectation(schema: JsonSchema, direction: 'small' | 'big'): string | undefined {
  const type = schemaType(schema);
  const keyword =
    direction === 'small'
      ? type === 'string'
        ? 'minLength'
        : type === 'array'
          ? 'minItems'
          : 'minimum'
      : type === 'string'
        ? 'maxLength'
        : type === 'array'
          ? 'maxItems'
          : 'maximum';
  const value = schemaNumber(schema[keyword]);
  if (value === undefined) return undefined;
  const label = type === 'string' ? 'string length' : type === 'array' ? 'array length' : type;
  if (label === undefined) return undefined;
  return `expected ${label} ${direction === 'small' ? 'at least' : 'at most'} ${value}`;
}

function schemaExpectation(schema: JsonSchema, issueCode: string): string {
  switch (issueCode) {
    case 'invalid_type':
      return schemaTypeExpectation(schema) ?? 'failed structural validation';
    case 'invalid_value':
      return (
        schemaEnumExpectation(schema) ??
        schemaTypeExpectation(schema) ??
        'failed structural validation'
      );
    case 'too_small':
      return (
        schemaSizeExpectation(schema, 'small') ??
        schemaTypeExpectation(schema) ??
        'failed structural validation'
      );
    case 'too_big':
      return (
        schemaSizeExpectation(schema, 'big') ??
        schemaTypeExpectation(schema) ??
        'failed structural validation'
      );
    case 'not_multiple_of': {
      const multipleOf = schemaNumber(schema.multipleOf);
      return multipleOf === undefined
        ? (schemaTypeExpectation(schema) ?? 'failed structural validation')
        : `expected a multiple of ${multipleOf}`;
    }
    case 'invalid_format': {
      const format = schema.format;
      return typeof format === 'string' && SAFE_STRING_FORMATS.has(format)
        ? `expected valid ${format} format`
        : (schemaTypeExpectation(schema) ?? 'failed structural validation');
    }
    case 'invalid_union':
      return schemaTypeExpectation(schema) ?? 'failed structural validation';
    default: {
      const typeExpectation = schemaTypeExpectation(schema);
      return typeExpectation === undefined
        ? 'failed structural validation'
        : `failed structural validation; ${typeExpectation}`;
    }
  }
}

/**
 * Recursively validate string lengths in parsed tool arguments.
 * Throws if any string exceeds the configured max length.
 */
class ToolStringLengthError extends Error {
  constructor(
    readonly path: readonly (string | number)[],
    readonly actual: number,
    readonly maximum: number,
  ) {
    const renderedPath = path.reduce<string>(
      (current, part) =>
        typeof part === 'number' ? `${current}[${part}]` : current ? `${current}.${part}` : part,
      '',
    );
    super(
      `String argument${renderedPath ? ` at "${renderedPath}"` : ''} exceeds maximum length (${actual} > ${maximum})`,
    );
    this.name = 'ToolStringLengthError';
  }
}

/** Build bounded, model-safe corrective feedback from provider-visible schema only. */
export function toolArgumentModelMessage(
  error: unknown,
  providerVisibleSchema: unknown,
): string | undefined {
  try {
    let lines: string[];
    let omitted = false;

    if (error instanceof ZodError) {
      if (error.issues.length === 0) return undefined;
      lines = [];
      for (const issue of error.issues.slice(0, MAX_MODEL_ARGUMENT_ISSUES)) {
        const resolved = resolveSchemaPath(providerVisibleSchema, issue.path);
        if (resolved === undefined) return undefined;
        const path = jsonPointerPath(resolved.segments);
        const expectation = schemaExpectation(resolved.node, issue.code);
        lines.push(
          truncateModelFeedback(`- ${path}: ${expectation}`, MAX_MODEL_ARGUMENT_LINE_LENGTH),
        );
      }
      omitted = error.issues.length > lines.length;
    } else if (error instanceof ToolStringLengthError) {
      const resolved = resolveSchemaPath(providerVisibleSchema, error.path);
      const maximum = schemaNumber(error.maximum);
      if (resolved === undefined || maximum === undefined) return undefined;
      const path = jsonPointerPath(resolved.segments);
      lines = [`- ${path}: maximum string length is ${maximum}`];
    } else {
      return undefined;
    }

    const header = 'Error: Invalid tool arguments:';
    const footer = 'Correct the arguments and try again.';
    const omission = omitted ? 'Additional validation issues were omitted.' : undefined;
    const parts = [header, ...lines, ...(omission ? [omission] : []), footer];
    const message = parts.join('\n');
    return message.length <= MAX_MODEL_ARGUMENT_MESSAGE_LENGTH ? message : undefined;
  } catch {
    return undefined;
  }
}

function validateStringLengths(
  value: unknown,
  maxLen: number,
  path: readonly (string | number)[] = [],
): void {
  if (typeof value === 'string') {
    if (value.length > maxLen) {
      throw new ToolStringLengthError(path, value.length, maxLen);
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateStringLengths(value[i], maxLen, [...path, i]);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      validateStringLengths(val, maxLen, [...path, key]);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  try {
    return (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    );
  } catch {
    return false;
  }
}

/** Convert local input failures to provider-corrective structural issues. */
export function toolArgumentIssues(error: unknown): ToolArgumentIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => ({
      path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
      code: issue.code,
      message: issue.message,
    }));
  }
  if (error instanceof ToolStringLengthError) {
    return [
      {
        path: error.path,
        code: 'too_big',
        message: error.message,
      },
    ];
  }
  return [{ path: [], code: 'invalid_arguments', message: 'Tool arguments are invalid.' }];
}

type ToolExecutionOptions = {
  signal?: AbortSignal;
  onAttempt?: (attempt: number) => void;
  /** Lifecycle coordinator classifies a returned value followed by abort as
   * `after_handler`; direct `_execute()` retains its historical abort check. */
  checkAfterHandlerAbort?: boolean;
};

type ToolInternals = {
  prepareInput(input: unknown): unknown;
  executePrepared(
    input: unknown,
    ctx?: WorkflowContext,
    options?: ToolExecutionOptions,
  ): Promise<unknown>;
};

const TOOL_INTERNALS = new WeakMap<object, ToolInternals>();

function getToolInternals(tool: Tool): ToolInternals {
  const internals = TOOL_INTERNALS.get(tool as object);
  if (!internals) throw new Error(`Tool "${tool.name}" was not created by tool()`);
  return internals;
}

/** Internal agent-call seam: validate once before lifecycle acceptance. */
export function prepareToolInput(tool: Tool, input: unknown): unknown {
  return getToolInternals(tool).prepareInput(input);
}

/** Internal agent-call seam: execute previously validated input. */
export function executePreparedTool(
  tool: Tool,
  input: unknown,
  ctx: WorkflowContext,
  options?: ToolExecutionOptions,
): Promise<unknown> {
  return getToolInternals(tool).executePrepared(input, ctx, options);
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
export function tool<TInput extends z.ZodType, TOutput = unknown>(
  config: ToolConfig<TInput, TOutput>,
): Tool<TInput, TOutput> {
  const retryPolicy: RetryPolicy = {
    attempts: config.retry?.attempts ?? 1,
    backoff: config.retry?.backoff ?? 'exponential',
    on: config.retry?.on,
  };

  const maxStringLen = config.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const prepareInput = (input: unknown): z.infer<TInput> => {
    const parsed = config.input.parse(input);
    if (maxStringLen > 0) {
      validateStringLengths(parsed, maxStringLen);
    }
    return parsed;
  };

  const executePrepared = async (
    parsed: z.infer<TInput>,
    ctx?: WorkflowContext,
    options?: ToolExecutionOptions,
  ): Promise<TOutput> => {
    const maxAttempts = retryPolicy.attempts ?? 1;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      options?.signal?.throwIfAborted();
      options?.onAttempt?.(attempt);
      try {
        // ctx is optional on _execute but required on handler. In practice, all runtime
        // call sites (agent tool loop, tool.run) always provide ctx. The undefined case
        // only occurs when _execute is called directly in tests or internal code.
        const result = await config.handler(parsed, ctx as WorkflowContext);
        if (options?.checkAfterHandlerAbort !== false) options?.signal?.throwIfAborted();
        return result;
      } catch (err) {
        if (options?.signal?.aborted) options.signal.throwIfAborted();
        if (isAbortError(err)) throw err;
        rethrowEventStreamOverflow(err);
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt === maxAttempts) break;

        // Check retry predicate
        if (retryPolicy.on && !retryPolicy.on(lastError as Error & { status?: number })) {
          break;
        }

        // Apply backoff
        const backoffMs = getBackoffMs(attempt, retryPolicy.backoff ?? 'exponential');
        if (backoffMs > 0) {
          await sleep(backoffMs, options?.signal);
        }
      }
    }

    throw lastError;
  };

  const execute = async (input: z.infer<TInput>, ctx?: WorkflowContext): Promise<TOutput> =>
    executePrepared(prepareInput(input), ctx);

  const instance: Tool<TInput, TOutput> = {
    name: config.name,
    description: config.description,
    inputSchema: config.input,
    sensitive: config.sensitive ?? false,
    retry: retryPolicy,
    requireApproval: config.requireApproval ?? false,
    hooks: config.hooks,
    ...(config.toModelOutput !== undefined ? { toModelOutput: config.toModelOutput } : {}),

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
  TOOL_INTERNALS.set(instance, {
    prepareInput,
    executePrepared: executePrepared as ToolInternals['executePrepared'],
  });
  return instance;
}
