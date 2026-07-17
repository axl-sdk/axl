import { ToolModelOutputError } from './errors.js';
import { serializeToolModelOutput } from './tool-model-output.js';
import type { SpanHandle } from './telemetry/types.js';
import type { Tool } from './tool.js';
import type { WorkflowContext } from './context.js';
import type { McpToolResult } from './mcp/types.js';
import type { ToolCallMessage } from './types.js';

/** Compatibility outcome used while the v1 writer remains active. */
export type LegacyToolExecutionOutcome =
  | { kind: 'returned'; value: unknown }
  | { kind: 'thrown'; value: { error: string } };

export type LegacyToolArgumentParse =
  | { ok: true; args: unknown }
  | { ok: false; modelMessage: string };

/** Parse the provider's JSON argument string without emitting or mutating state. */
export function parseLegacyToolArguments(raw: string): LegacyToolArgumentParse {
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      modelMessage: 'Error: Invalid JSON in tool arguments. Please provide valid JSON.',
    };
  }
}

type LegacyToolInvocationSource =
  | { kind: 'override'; execute: (args: unknown) => Promise<unknown> }
  | { kind: 'local'; tool: Tool }
  | { kind: 'mcp'; call: (args: unknown) => Promise<McpToolResult> };

export type PreparedLegacyToolInvocation = {
  requestedTool: string;
  traceName: string;
  callId: string;
  args: unknown;
  configuredTool?: Tool;
  source: LegacyToolInvocationSource;
};

export type LegacyToolInvocationRejection =
  | { kind: 'unavailable'; requestedTool: string; availableTools: string[] }
  | { kind: 'invalid_json'; requestedTool: string; callId: string; modelMessage: string };

/** Resolve provider input into one explicit v1 invocation source. */
export function parseToolInvocationV1(options: {
  toolCall: ToolCallMessage;
  configuredTool?: Tool;
  override?: (args: unknown) => Promise<unknown>;
  mcpCall?: (args: unknown) => Promise<McpToolResult>;
  mcpTraceName?: string;
  availableTools: string[];
}): PreparedLegacyToolInvocation | LegacyToolInvocationRejection {
  const { toolCall, configuredTool, override, mcpCall, mcpTraceName, availableTools } = options;
  const requestedTool = toolCall.function.name;

  // Configured mocks intentionally win even when no real tool is registered.
  if (!override && !configuredTool && !mcpCall) {
    return { kind: 'unavailable', requestedTool, availableTools };
  }

  const parsed = parseLegacyToolArguments(toolCall.function.arguments);
  if (!parsed.ok) {
    return {
      kind: 'invalid_json',
      requestedTool,
      callId: toolCall.id,
      modelMessage: parsed.modelMessage,
    };
  }

  const source: LegacyToolInvocationSource = override
    ? { kind: 'override', execute: override }
    : configuredTool
      ? { kind: 'local', tool: configuredTool }
      : { kind: 'mcp', call: mcpCall! };

  return {
    requestedTool,
    traceName: source.kind === 'mcp' ? (mcpTraceName ?? requestedTool) : requestedTool,
    callId: toolCall.id,
    args: parsed.args,
    configuredTool,
    source,
  };
}

/** Capture the v1 continuation behavior for a thrown tool boundary. */
export async function captureLegacyToolExecution(
  execute: () => unknown | Promise<unknown>,
): Promise<LegacyToolExecutionOutcome> {
  try {
    return { kind: 'returned', value: await execute() };
  } catch (error) {
    return {
      kind: 'thrown',
      value: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

type LegacySourceExecution = {
  outcome: LegacyToolExecutionOutcome;
  resultContent?: string;
};

export type LegacyAcceptedToolResult =
  | { kind: 'denied'; reason: string; effectiveArgs: unknown }
  | { kind: 'before_hook_failed'; message: string; effectiveArgs: unknown }
  | {
      kind: 'completed';
      effectiveArgs: unknown;
      execution: LegacySourceExecution;
    };

/** Execute accepted v1 phases without emitting events or appending messages. */
export async function executeAcceptedToolV1(options: {
  invocation: PreparedLegacyToolInvocation;
  context: WorkflowContext;
  requestApproval: () => Promise<{ approved: boolean; reason?: string }>;
  createChildContext: () => WorkflowContext;
  observeExecution: (
    execute: () => Promise<LegacySourceExecution>,
  ) => Promise<LegacySourceExecution>;
}): Promise<LegacyAcceptedToolResult> {
  const { invocation, context, requestApproval, createChildContext, observeExecution } = options;
  let effectiveArgs = invocation.args;

  if (invocation.source.kind === 'local' && invocation.source.tool.requireApproval) {
    const approval = await requestApproval();
    if (!approval.approved) {
      return {
        kind: 'denied',
        reason: approval.reason ?? 'Denied by human',
        effectiveArgs,
      };
    }
  }

  if (invocation.source.kind === 'local' && invocation.source.tool.hooks?.before) {
    try {
      effectiveArgs = await invocation.source.tool.hooks.before(effectiveArgs as never, context);
    } catch (error) {
      return {
        kind: 'before_hook_failed',
        message: error instanceof Error ? error.message : String(error),
        effectiveArgs,
      };
    }
  }

  const execution = await observeExecution(async () => {
    const source = invocation.source;
    switch (source.kind) {
      case 'override': {
        // Preserve the legacy plain-function call contract. Calling through
        // `source.execute(...)` would expose the source record as `this`.
        const executeOverride = source.execute;
        return {
          outcome: await captureLegacyToolExecution(() => executeOverride(effectiveArgs)),
        };
      }
      case 'mcp': {
        // Keep call + result inspection inside one capture boundary. Legacy MCP
        // clients cast protocol payloads, so malformed content must still
        // become a continued `{error}` outcome instead of aborting the ask.
        let resultContent: string | undefined;
        const outcome = await captureLegacyToolExecution(async () => {
          const result = await source.call(effectiveArgs);
          resultContent = result.content
            .map((content) => (content.type === 'text' ? content.text : `[${content.type}]`))
            .join('\n');
          if (result.isError) resultContent = `Error: ${resultContent}`;
          return result;
        });
        if (outcome.kind === 'thrown') resultContent = JSON.stringify(outcome.value);
        return { outcome, resultContent };
      }
      case 'local': {
        const childContext = createChildContext();
        let outcome = await captureLegacyToolExecution(() =>
          source.tool._execute(effectiveArgs as never, childContext),
        );
        const suppressInspection = source.tool.sensitive || source.tool.toModelOutput !== undefined;
        if (
          outcome.kind === 'returned' &&
          source.tool.hooks?.after &&
          !(suppressInspection
            ? isLegacyErrorShapedSafely(outcome.value)
            : isLegacyErrorShaped(outcome.value))
        ) {
          try {
            outcome = {
              kind: 'returned',
              value: await source.tool.hooks.after(outcome.value as never, context),
            };
          } catch (error) {
            outcome = {
              kind: 'thrown',
              value: {
                error: `After hook error: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
        }

        const resultContent = source.tool.sensitive
          ? '[REDACTED - sensitive tool output]'
          : outcome.kind === 'thrown' || source.tool.toModelOutput === undefined
            ? JSON.stringify(outcome.value)
            : undefined;
        return { outcome, resultContent };
      }
    }
  });

  return { kind: 'completed', effectiveArgs, execution };
}

export function isLegacyErrorShaped(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && 'error' in value;
}

export function isLegacyErrorShapedSafely(value: unknown): value is Record<string, unknown> {
  try {
    return isLegacyErrorShaped(value);
  } catch {
    return false;
  }
}

/** Record v1 span status, including its error-property heuristic. */
export function recordLegacyToolSpanResult(
  span: SpanHandle,
  value: unknown,
  suppressInspectionErrors: boolean,
): void {
  let isError = false;
  let errorMessage: unknown;
  const inspect = () => {
    if (isLegacyErrorShaped(value)) {
      isError = true;
      errorMessage = value.error;
    } else {
      isError = false;
    }
  };

  if (suppressInspectionErrors) {
    try {
      inspect();
    } catch {
      // The legacy error-property sentinel is observability metadata, not part
      // of projection eligibility. A hostile proxy must not bypass a configured
      // sensitive/projection policy or leak its trap error into ask events.
      isError = false;
      errorMessage = undefined;
    }
  } else {
    inspect();
  }

  span.setAttribute('axl.tool.success', !isError);
  if (isError) span.setStatus('error', errorMessage as string);
}

function prepareToolModelOutput(toolName: string, project: () => unknown): string {
  let output: unknown;
  try {
    output = project();
  } catch (cause) {
    throw new ToolModelOutputError(toolName, cause);
  }
  return serializeToolModelOutput(toolName, output);
}

/**
 * Preserve the v1 model-output/event ordering until the atomic v2 writer
 * switch. Projection emits the complete host result first; legacy
 * serialization emits only after serialization succeeds.
 */
export function finalizeLegacyToolResult(options: {
  toolName: string;
  configuredTool: Tool | undefined;
  outcome: LegacyToolExecutionOutcome;
  legacyContent: () => string;
  emitEnd: () => void;
  beforeProjection: () => void;
}): string {
  const { toolName, configuredTool, outcome, legacyContent, emitEnd, beforeProjection } = options;
  const projectionEligible =
    configuredTool !== undefined &&
    !configuredTool.sensitive &&
    outcome.kind === 'returned' &&
    configuredTool.toModelOutput !== undefined;

  if (projectionEligible) {
    emitEnd();
    beforeProjection();
    const project = configuredTool.toModelOutput!;
    return prepareToolModelOutput(toolName, () => project(outcome.value as never));
  }

  const content = legacyContent();
  emitEnd();
  return content;
}
