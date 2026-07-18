import {
  isEventStreamOverflowError,
  rethrowEventStreamOverflow,
  ToolFailure,
  ToolModelOutputError,
} from './errors.js';
import { serializeToolModelOutput } from './tool-model-output.js';
import { executePreparedTool, prepareToolInput, toolArgumentIssues, type Tool } from './tool.js';
import type { WorkflowContext } from './context.js';
import type { McpToolResult } from './mcp/types.js';
import type {
  ToolCallCancellation,
  ToolCallFailure,
  ToolCallMessage,
  ToolCallOutcome,
  ToolCallRejectedData,
  ToolEventError,
} from './types.js';
import type { SpanHandle } from './telemetry/types.js';

const INVALID_JSON_MODEL_MESSAGE =
  'Error: Invalid JSON in tool arguments. Please provide valid JSON.';
const INVALID_ARGUMENTS_MODEL_MESSAGE =
  'Error: Tool arguments are invalid. Correct the arguments and try again.';
const SENSITIVE_SUCCESS_MESSAGE = '[REDACTED - sensitive tool output]';
const SENSITIVE_FAILURE_MESSAGE = '[REDACTED - sensitive tool failure]';
const MAX_MCP_MODEL_ERROR_LENGTH = 2_000;

type ToolInvocationSource =
  | { kind: 'override'; execute: (args: unknown) => Promise<unknown> }
  | { kind: 'local'; tool: Tool }
  | { kind: 'mcp'; call: (args: unknown) => Promise<McpToolResult> };

export type PreparedToolInvocation = {
  requestedTool: string;
  toolName: string;
  callId: string;
  /** Validated, pre-before-hook logical arguments retained in both events. */
  args: unknown;
  configuredTool?: Tool;
  source: ToolInvocationSource;
};

export type ToolInvocationRejection = {
  kind: 'rejected';
  requestedTool: string;
  toolName: string;
  callId: string;
  data: ToolCallRejectedData;
  modelMessage: string;
};

export function cloneToolArguments(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new Error('Prepared tool arguments must be structured-cloneable');
  }
}

/** Resolve and validate a provider request before lifecycle acceptance. */
export function parseToolInvocation(options: {
  toolCall: ToolCallMessage;
  configuredTool?: Tool;
  override?: (args: unknown) => Promise<unknown>;
  mcpCall?: (args: unknown) => Promise<McpToolResult>;
  mcpTraceName?: string;
  availableTools: string[];
}): PreparedToolInvocation | ToolInvocationRejection {
  const { toolCall, configuredTool, override, mcpCall, mcpTraceName, availableTools } = options;
  const requestedTool = toolCall.function.name;

  // Configured mocks intentionally win even when no real tool is registered.
  if (!override && !configuredTool && !mcpCall) {
    return {
      kind: 'rejected',
      requestedTool,
      toolName: requestedTool,
      callId: toolCall.id,
      data: { reason: 'unavailable', requestedTool, availableTools },
      modelMessage: `Tool "${requestedTool}" is not available. Available tools: ${
        availableTools.length > 0 ? availableTools.join(', ') : 'none'
      }`,
    };
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.function.arguments);
  } catch {
    return {
      kind: 'rejected',
      requestedTool,
      toolName: mcpTraceName ?? requestedTool,
      callId: toolCall.id,
      data: {
        reason: 'invalid_json',
        requestedTool,
        message: 'Tool arguments were not valid JSON.',
      },
      modelMessage: INVALID_JSON_MODEL_MESSAGE,
    };
  }
  if (
    typeof parsedArguments !== 'object' ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    return {
      kind: 'rejected',
      requestedTool,
      toolName: mcpTraceName ?? requestedTool,
      callId: toolCall.id,
      data: {
        reason: 'invalid_json',
        requestedTool,
        message: 'Tool arguments must decode to a JSON object.',
      },
      modelMessage: INVALID_JSON_MODEL_MESSAGE,
    };
  }

  const source: ToolInvocationSource = override
    ? { kind: 'override', execute: override }
    : configuredTool
      ? { kind: 'local', tool: configuredTool }
      : { kind: 'mcp', call: mcpCall! };

  let preparedArguments: unknown = parsedArguments;
  if (source.kind === 'local') {
    try {
      preparedArguments = prepareToolInput(source.tool, parsedArguments);
    } catch (error) {
      return {
        kind: 'rejected',
        requestedTool,
        toolName: requestedTool,
        callId: toolCall.id,
        data: {
          reason: 'invalid_arguments',
          requestedTool,
          args: parsedArguments,
          issues: toolArgumentIssues(error),
        },
        modelMessage: INVALID_ARGUMENTS_MODEL_MESSAGE,
      };
    }
  }

  try {
    preparedArguments = cloneToolArguments(preparedArguments);
  } catch (error) {
    return {
      kind: 'rejected',
      requestedTool,
      toolName: source.kind === 'mcp' ? (mcpTraceName ?? requestedTool) : requestedTool,
      callId: toolCall.id,
      data: {
        reason: 'invalid_arguments',
        requestedTool,
        args: parsedArguments,
        issues: toolArgumentIssues(error),
      },
      modelMessage: INVALID_ARGUMENTS_MODEL_MESSAGE,
    };
  }

  return {
    requestedTool,
    toolName: source.kind === 'mcp' ? (mcpTraceName ?? requestedTool) : requestedTool,
    callId: toolCall.id,
    args: preparedArguments,
    configuredTool,
    source,
  };
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

function normalizeAbortError(reason: unknown): Error {
  if (isAbortError(reason)) return reason as Error;

  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  if (reason !== undefined) {
    Object.defineProperty(error, 'cause', { value: reason, enumerable: false });
  }
  return error;
}

function cancellationError(signal: AbortSignal | undefined, error?: unknown): unknown | undefined {
  if (signal?.aborted) return normalizeAbortError(signal.reason);
  return isAbortError(error) ? normalizeAbortError(error) : undefined;
}

function eventError(error: unknown): ToolEventError {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    // Hostile proxies and custom thrown values must not escape settlement.
  }
  if (isError) {
    const read = (key: 'name' | 'message' | 'code' | 'cause'): unknown => {
      try {
        return Reflect.get(error as object, key);
      } catch {
        return undefined;
      }
    };
    const name = read('name');
    const message = read('message');
    const code = read('code');
    const cause = read('cause');
    return {
      name: typeof name === 'string' ? name : 'Error',
      message: typeof message === 'string' ? message : 'Unknown error',
      ...(typeof code === 'string' ? { code } : {}),
      ...(cause !== undefined ? { cause } : {}),
    };
  }
  try {
    return { name: 'Error', message: String(error) };
  } catch {
    return { name: 'Error', message: 'Unknown thrown value' };
  }
}

function isToolFailure(error: unknown): error is ToolFailure {
  try {
    return error instanceof ToolFailure;
  } catch {
    return false;
  }
}

function cancellation(
  phase: ToolCallCancellation['phase'],
  error: unknown,
  result?: unknown,
): InternalToolOutcome {
  let reason: string | undefined;
  try {
    reason =
      error instanceof Error && typeof error.message === 'string' ? error.message : undefined;
  } catch {
    // A cancellation remains structural when its reason is not safely readable.
  }
  const cancellation =
    phase === 'after_handler' ||
    phase === 'after_hook' ||
    phase === 'projection' ||
    phase === 'serialization'
      ? { phase, result, ...(reason ? { reason } : {}) }
      : { phase, ...(reason ? { reason } : {}) };
  return {
    kind: 'cancelled',
    cancellation,
    error: normalizeAbortError(error),
  } as InternalToolOutcome;
}

type InternalToolOutcome =
  | { kind: 'succeeded'; result: unknown }
  | { kind: 'denied'; reason?: string }
  | {
      kind: 'failed';
      failure: ToolCallFailure;
      error: unknown;
      modelMessage?: string;
    }
  | { kind: 'cancelled'; cancellation: ToolCallCancellation; error: unknown };

function failed(
  phase: 'before_hook' | 'handler' | 'after_hook',
  error: unknown,
  options: { attempts?: number; result?: unknown } = {},
): InternalToolOutcome {
  let modelMessage: string | undefined;
  if (isToolFailure(error)) {
    try {
      modelMessage = typeof error.modelMessage === 'string' ? error.modelMessage : undefined;
    } catch {
      // A hostile proxy is not a valid explicit model-safe failure.
    }
  }
  const toolFailure = modelMessage !== undefined;
  const common = {
    phase,
    kind: toolFailure ? ('tool_failure' as const) : ('unexpected' as const),
    disposition: toolFailure ? ('continue' as const) : ('abort' as const),
    error: eventError(error),
  };
  const failure =
    phase === 'handler'
      ? { ...common, attempts: options.attempts ?? 1 }
      : phase === 'after_hook'
        ? { ...common, result: options.result }
        : common;
  return {
    kind: 'failed',
    failure: failure as ToolCallFailure,
    error,
    ...(modelMessage !== undefined ? { modelMessage } : {}),
  };
}

function mcpContent(result: McpToolResult): string {
  return result.content
    .map((content) => (content.type === 'text' ? content.text : `[${content.type}]`))
    .join('\n');
}

function safeMcpModelError(content: string): string {
  let normalized = '';
  for (const character of content) {
    const code = character.charCodeAt(0);
    normalized +=
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f
        ? ' '
        : character;
  }
  return `MCP tool error: ${normalized.slice(0, MAX_MCP_MODEL_ERROR_LENGTH)}`;
}

/** Execute accepted phases without emitting events or constructing messages. */
export async function executeAcceptedTool(options: {
  invocation: PreparedToolInvocation;
  context: WorkflowContext;
  signal?: AbortSignal;
  requestApproval: () => Promise<{ approved: boolean; reason?: string }>;
  createChildContext: () => WorkflowContext;
}): Promise<InternalToolOutcome> {
  const { invocation, context, signal, requestApproval, createChildContext } = options;
  let effectiveArgs = cloneToolArguments(invocation.args);

  if (invocation.source.kind === 'local' && invocation.source.tool.requireApproval) {
    try {
      signal?.throwIfAborted();
      const approval = await requestApproval();
      signal?.throwIfAborted();
      if (!approval.approved) return { kind: 'denied', reason: approval.reason };
    } catch (error) {
      rethrowEventStreamOverflow(error);
      const abort = cancellationError(signal, error);
      if (abort !== undefined) return cancellation('approval', abort);
      return {
        kind: 'failed',
        failure: {
          phase: 'approval',
          kind: 'infrastructure',
          disposition: 'abort',
          error: eventError(error),
        },
        error,
      };
    }
  }

  if (invocation.source.kind === 'local' && invocation.source.tool.hooks?.before) {
    try {
      signal?.throwIfAborted();
      effectiveArgs = await invocation.source.tool.hooks.before(effectiveArgs as never, context);
      signal?.throwIfAborted();
    } catch (error) {
      rethrowEventStreamOverflow(error);
      const abort = cancellationError(signal, error);
      if (abort !== undefined) return cancellation('before_hook', abort);
      return failed('before_hook', error);
    }
  }

  let result: unknown;
  let attempts = 1;
  try {
    signal?.throwIfAborted();
    switch (invocation.source.kind) {
      case 'override': {
        const executeOverride = invocation.source.execute;
        result = await executeOverride(effectiveArgs);
        break;
      }
      case 'local':
        result = await executePreparedTool(
          invocation.source.tool,
          effectiveArgs,
          createChildContext(),
          {
            signal,
            onAttempt: (attempt) => (attempts = attempt),
            checkAfterHandlerAbort: false,
          },
        );
        break;
      case 'mcp': {
        const mcpResult = await invocation.source.call(effectiveArgs);
        if (signal?.aborted) return cancellation('after_handler', signal.reason, mcpResult);
        if (mcpResult.isError) {
          const content = mcpContent(mcpResult);
          const error = new Error(content || 'MCP tool returned an error');
          return {
            kind: 'failed',
            failure: {
              phase: 'handler',
              kind: 'mcp_error',
              disposition: 'continue',
              error: { name: 'McpToolError', message: error.message, code: 'MCP_TOOL_ERROR' },
              attempts: 1,
            },
            error,
            modelMessage: safeMcpModelError(content),
          };
        }
        result = mcpResult;
        break;
      }
    }
  } catch (error) {
    rethrowEventStreamOverflow(error);
    const abort = cancellationError(signal, error);
    if (abort !== undefined) return cancellation('handler', abort);
    return failed('handler', error, { attempts });
  }

  if (signal?.aborted) return cancellation('after_handler', signal.reason, result);

  if (invocation.source.kind === 'local' && invocation.source.tool.hooks?.after) {
    const rawResult = result;
    try {
      result = await invocation.source.tool.hooks.after(result as never, context);
      signal?.throwIfAborted();
    } catch (error) {
      rethrowEventStreamOverflow(error);
      const abort = cancellationError(signal, error);
      if (abort !== undefined) return cancellation('after_hook', abort, rawResult);
      return failed('after_hook', error, { result: rawResult });
    }
  }

  return { kind: 'succeeded', result };
}

type PreparedToolMessage =
  | { ok: true; content: string }
  | { ok: false; phase: 'projection' | 'serialization'; error: unknown };

/** Prepare the model-facing message after execution has settled successfully. */
export function prepareToolMessage(
  invocation: PreparedToolInvocation,
  outcome: InternalToolOutcome,
): PreparedToolMessage {
  const sensitive = invocation.configuredTool?.sensitive === true;

  if (outcome.kind === 'denied') {
    return {
      ok: true,
      content: JSON.stringify({ error: 'Tool request was denied by human approval.' }),
    };
  }
  if (outcome.kind === 'failed') {
    if (outcome.failure.disposition !== 'continue' || outcome.modelMessage === undefined) {
      throw new Error('Aborting tool failures cannot produce provider messages');
    }
    return { ok: true, content: sensitive ? SENSITIVE_FAILURE_MESSAGE : outcome.modelMessage };
  }
  if (outcome.kind !== 'succeeded') {
    throw new Error('Cancelled tool calls cannot produce provider messages');
  }

  if (sensitive) return { ok: true, content: SENSITIVE_SUCCESS_MESSAGE };
  if (invocation.source.kind === 'mcp') {
    try {
      return { ok: true, content: mcpContent(outcome.result as McpToolResult) };
    } catch (error) {
      rethrowEventStreamOverflow(error);
      return { ok: false, phase: 'serialization', error };
    }
  }

  if (invocation.configuredTool?.toModelOutput) {
    try {
      const project = invocation.configuredTool.toModelOutput;
      return {
        ok: true,
        content: serializeToolModelOutput(
          invocation.requestedTool,
          project(outcome.result as never),
        ),
      };
    } catch (error) {
      rethrowEventStreamOverflow(error);
      if (error instanceof ToolModelOutputError && isEventStreamOverflowError(error.cause)) {
        throw error.cause;
      }
      return {
        ok: false,
        phase: 'projection',
        error:
          error instanceof ToolModelOutputError && error.toolName === invocation.requestedTool
            ? error
            : new ToolModelOutputError(invocation.requestedTool, error),
      };
    }
  }

  try {
    const content = JSON.stringify(outcome.result);
    if (content === undefined) throw new Error('Tool result is not JSON serializable');
    return { ok: true, content };
  } catch (error) {
    rethrowEventStreamOverflow(error);
    return { ok: false, phase: 'serialization', error };
  }
}

export type SettledToolInvocation = {
  outcome: ToolCallOutcome;
  providerContent?: string;
  abortError?: unknown;
};

/** Add model-output preparation and cancellation precedence to execution. */
export async function settleAcceptedTool(options: {
  invocation: PreparedToolInvocation;
  context: WorkflowContext;
  signal?: AbortSignal;
  requestApproval: () => Promise<{ approved: boolean; reason?: string }>;
  createChildContext: () => WorkflowContext;
}): Promise<SettledToolInvocation> {
  const internal = await executeAcceptedTool(options);
  if (internal.kind === 'cancelled') {
    return {
      outcome: { status: 'cancelled', cancellation: internal.cancellation },
      abortError: internal.error,
    };
  }
  if (internal.kind === 'failed' && internal.failure.disposition === 'abort') {
    return {
      outcome: { status: 'failed', failure: internal.failure },
      abortError: internal.error,
    };
  }

  const result = internal.kind === 'succeeded' ? internal.result : undefined;
  const outputPhase =
    internal.kind === 'succeeded' &&
    !options.invocation.configuredTool?.sensitive &&
    options.invocation.source.kind !== 'mcp' &&
    options.invocation.configuredTool?.toModelOutput
      ? 'projection'
      : 'serialization';
  if (internal.kind === 'succeeded' && options.signal?.aborted) {
    return {
      outcome: {
        status: 'cancelled',
        cancellation: { phase: outputPhase, result },
      },
      abortError: normalizeAbortError(options.signal.reason),
    };
  }

  const prepared = prepareToolMessage(options.invocation, internal);
  if (internal.kind === 'succeeded' && options.signal?.aborted) {
    return {
      outcome: {
        status: 'cancelled',
        cancellation: { phase: outputPhase, result },
      },
      abortError: normalizeAbortError(options.signal.reason),
    };
  }
  if (!prepared.ok) {
    const outputAbort =
      cancellationError(options.signal, prepared.error) ??
      (prepared.error instanceof ToolModelOutputError
        ? cancellationError(options.signal, prepared.error.cause)
        : undefined);
    if (outputAbort !== undefined) {
      return {
        outcome: {
          status: 'cancelled',
          cancellation: { phase: prepared.phase, result },
        },
        abortError: outputAbort,
      };
    }
    const failure: ToolCallFailure = {
      phase: prepared.phase,
      kind: 'output',
      disposition: 'abort',
      error: eventError(prepared.error),
      result,
    };
    return {
      outcome: { status: 'failed', failure },
      abortError: prepared.error,
    };
  }

  if (internal.kind === 'succeeded') {
    return {
      outcome: { status: 'succeeded', result: internal.result },
      providerContent: prepared.content,
    };
  }
  if (internal.kind === 'denied') {
    return {
      outcome: { status: 'denied', ...(internal.reason ? { reason: internal.reason } : {}) },
      providerContent: prepared.content,
    };
  }
  return {
    outcome: { status: 'failed', failure: internal.failure },
    providerContent: prepared.content,
  };
}

/** Derive OTel status and structural attributes without copying raw errors/results. */
export function recordToolSpanOutcome(span: SpanHandle, outcome: ToolCallOutcome): void {
  span.setAttribute('axl.tool.outcome', outcome.status);
  span.setAttribute('axl.tool.success', outcome.status === 'succeeded');
  switch (outcome.status) {
    case 'succeeded':
      span.setStatus('ok');
      return;
    case 'denied':
      span.setStatus('unset');
      return;
    case 'failed':
      span.setAttribute('axl.tool.phase', outcome.failure.phase);
      span.setStatus('error');
      return;
    case 'cancelled':
      span.setAttribute('axl.tool.phase', outcome.cancellation.phase);
      span.setStatus('error');
  }
}
