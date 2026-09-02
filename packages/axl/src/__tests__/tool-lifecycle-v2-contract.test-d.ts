/** Compile-only lock for the next-major tool lifecycle and history contracts. */
import type {
  AxlEventV2,
  AxlEvent,
  AxlRuntime,
  AxlEventV2Of,
  ExecutionInfoV2,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  LegacyExecutionInfoV1,
  ToolCallEndData,
  ToolCallFailure,
  ToolCallOutcome,
  ToolCallRejectedData,
  ToolCallRejectedEvent,
  ToolCallStartDataV2,
  ToolFailure,
  ToolFailureConstructor,
  LegacyAxlEventV1,
  RetryPolicy,
} from '../index.js';

declare const runtime: AxlRuntime;
// @ts-expect-error callback observation was removed in favor of ctx.events/runtime.stream
runtime.createContext({ onToken: () => {} });
// @ts-expect-error callback observation was removed in favor of ctx.events
runtime.createContext({ onToolCall: () => {} });
// @ts-expect-error callback observation was removed in favor of typed events
runtime.createContext({ onAgentStart: () => {} });

const error = { name: 'Error', message: 'host diagnostic' } as const;
declare const ToolFailurePrototype: ToolFailureConstructor;
const toolFailure = new ToolFailurePrototype({
  message: 'host diagnostic',
  modelMessage: 'Please choose another account.',
  code: 'ACCOUNT_UNAVAILABLE',
  cause: error,
});
const throwable: Error = toolFailure;
const typedToolFailure: ToolFailure = toolFailure;
const retryPredicate: NonNullable<RetryPolicy['on']> = (caught) => caught === toolFailure;

const failures = [
  { phase: 'approval', kind: 'infrastructure', disposition: 'abort', error },
  { phase: 'before_hook', kind: 'tool_failure', disposition: 'continue', error },
  { phase: 'before_hook', kind: 'unexpected', disposition: 'abort', error },
  {
    phase: 'handler',
    kind: 'tool_failure',
    disposition: 'continue',
    error,
    attempts: 2,
  },
  { phase: 'handler', kind: 'mcp_error', disposition: 'continue', error, attempts: 1 },
  { phase: 'handler', kind: 'unexpected', disposition: 'abort', error, attempts: 3 },
  {
    phase: 'after_hook',
    kind: 'tool_failure',
    disposition: 'continue',
    error,
    result: { id: 1 },
  },
  {
    phase: 'after_hook',
    kind: 'unexpected',
    disposition: 'abort',
    error,
    result: { id: 1 },
  },
  {
    phase: 'projection',
    kind: 'output',
    disposition: 'abort',
    error,
    result: { id: 1 },
  },
  {
    phase: 'serialization',
    kind: 'output',
    disposition: 'abort',
    error,
    result: { id: 1 },
  },
] as const satisfies readonly ToolCallFailure[];

const outcomes = [
  { status: 'succeeded', result: { id: 1 } },
  { status: 'failed', failure: failures[0] },
  { status: 'denied', reason: 'not approved' },
  { status: 'cancelled', cancellation: { phase: 'approval' } },
  {
    status: 'cancelled',
    cancellation: { phase: 'after_handler', result: { id: 1 } },
  },
] as const satisfies readonly ToolCallOutcome[];

const endData = {
  args: { id: 1 },
  requestedTool: 'remote_lookup',
  outcome: outcomes[0],
} satisfies ToolCallEndData;

const rejections = [
  {
    reason: 'unavailable',
    requestedTool: 'missing',
    availableTools: ['lookup'],
  },
  { reason: 'invalid_json', requestedTool: 'lookup', message: 'Invalid JSON arguments' },
  {
    reason: 'invalid_arguments',
    requestedTool: 'lookup',
    args: { id: null },
    issues: [{ path: ['id'], code: 'invalid_type' }],
  },
] as const satisfies readonly ToolCallRejectedData[];

const startData = {
  args: { id: 1 },
  requestedTool: 'remote_lookup',
} satisfies ToolCallStartDataV2;

const endEvent = {
  schemaVersion: 2,
  type: 'tool_call_end',
  executionId: 'exec-1',
  askId: 'ask-1',
  depth: 0,
  agent: 'agent',
  step: 3,
  timestamp: 3,
  tool: 'lookup',
  callId: 'call-1',
  duration: 2,
  data: endData,
} satisfies AxlEventV2Of<'tool_call_end'>;

const liveEndEvent: AxlEvent = endEvent;

const rejectionEvent: ToolCallRejectedEvent = {
  schemaVersion: 2,
  type: 'tool_call_rejected',
  executionId: 'exec-1',
  askId: 'ask-1',
  depth: 0,
  agent: 'agent',
  step: 1,
  timestamp: 1,
  tool: 'missing',
  callId: 'call-1',
  data: rejections[0],
} satisfies AxlEventV2Of<'tool_call_rejected'>;

const v2WorkflowEvent = {
  schemaVersion: 2,
  type: 'workflow_start',
  executionId: 'exec-1',
  workflow: 'workflow',
  step: 0,
  timestamp: 0,
  data: { input: null },
} satisfies AxlEventV2Of<'workflow_start'>;

const v2Execution = {
  eventSchemaVersion: 2,
  executionId: 'exec-1',
  workflow: 'workflow',
  status: 'completed',
  events: [v2WorkflowEvent, endEvent, rejectionEvent],
  totalCost: 0,
  startedAt: 0,
  duration: 3,
} satisfies ExecutionInfoV2;

const legacyExecution = {
  executionId: 'exec-v1',
  workflow: 'workflow',
  status: 'completed',
  events: [],
  totalCost: 0,
  startedAt: 0,
  duration: 0,
} satisfies LegacyExecutionInfoV1;

const histories = [legacyExecution, v2Execution] satisfies HistoricalExecutionInfo[];

function assertOutcomeExhaustive(outcome: ToolCallOutcome): string {
  switch (outcome.status) {
    case 'succeeded':
      return String(outcome.result);
    case 'failed':
      return assertFailureExhaustive(outcome.failure);
    case 'denied':
      return outcome.reason ?? 'denied';
    case 'cancelled':
      return assertCancellationExhaustive(outcome.cancellation);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function assertFailureExhaustive(failure: ToolCallFailure): string {
  switch (failure.phase) {
    case 'approval':
      switch (failure.kind) {
        case 'infrastructure':
          return failure.kind;
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    case 'before_hook':
      switch (failure.kind) {
        case 'tool_failure':
        case 'unexpected':
          return failure.kind;
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    case 'handler':
      switch (failure.kind) {
        case 'tool_failure':
        case 'mcp_error':
        case 'unexpected':
          return failure.kind;
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    case 'after_hook':
      switch (failure.kind) {
        case 'tool_failure':
        case 'unexpected':
          return failure.kind;
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    case 'projection':
    case 'serialization':
      switch (failure.kind) {
        case 'output':
          return failure.kind;
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function assertRejectionExhaustive(rejection: ToolCallRejectedData): string {
  switch (rejection.reason) {
    case 'unavailable':
      return rejection.availableTools.join(',');
    case 'invalid_json':
      return rejection.message;
    case 'invalid_arguments':
      return rejection.issues.map((issue) => issue.code).join(',');
    default: {
      const exhaustive: never = rejection;
      return exhaustive;
    }
  }
}

function assertCancellationExhaustive(
  cancellation: Extract<ToolCallOutcome, { status: 'cancelled' }>['cancellation'],
): string {
  switch (cancellation.phase) {
    case 'approval':
    case 'before_hook':
    case 'handler':
    case 'after_handler':
    case 'after_hook':
    case 'projection':
    case 'serialization':
      return cancellation.phase;
    default: {
      const exhaustive: never = cancellation;
      return exhaustive;
    }
  }
}

// Invalid state combinations must remain unrepresentable.
// @ts-expect-error handler failures always include attempt count
const handlerWithoutAttempts: ToolCallFailure = {
  phase: 'handler',
  kind: 'unexpected',
  disposition: 'abort',
  error,
};

// @ts-expect-error output failures never continue
const continuingProjectionFailure: ToolCallFailure = {
  phase: 'projection',
  kind: 'output',
  disposition: 'continue',
  error,
  result: {},
};

const afterHandlerWithoutResult: ToolCallOutcome = {
  status: 'cancelled',
  // @ts-expect-error cancellation after a result exists must retain it
  cancellation: { phase: 'after_handler' },
};

const unversionedV2Event: AxlEventV2 = {
  ...endEvent,
  // @ts-expect-error all live v2 events carry the schema version
  schemaVersion: undefined,
};

const deniedEvent: AxlEventV2 = {
  ...endEvent,
  // @ts-expect-error v2 has no legacy unavailable-tool discriminator
  type: 'tool_denied',
};

// @ts-expect-error denied outcomes never carry a result
const deniedWithResult: ToolCallOutcome = { status: 'denied', result: {} };

// @ts-expect-error successful outcomes always carry their result
const successWithoutResult: ToolCallOutcome = { status: 'succeeded' };

const preResultCancellationWithResult: ToolCallOutcome = {
  status: 'cancelled',
  // @ts-expect-error pre-result cancellation cannot claim a result
  cancellation: { phase: 'handler', result: {} },
};

// @ts-expect-error new executions require the execution-level marker
const unversionedExecution: ExecutionInfoV2 = { ...v2Execution, eventSchemaVersion: undefined };

const versionedLegacyExecution: LegacyExecutionInfoV1 = {
  ...legacyExecution,
  eventSchemaVersion: 1,
};

const explicitlyVersionedLegacyEvent = {
  executionId: 'legacy-exec',
  step: 1,
  timestamp: 1,
  type: 'tool_denied',
  askId: 'legacy-ask',
  depth: 0,
  agent: 'legacy-agent',
  tool: 'missing',
  schemaVersion: 1,
} satisfies LegacyAxlEventV1;

const invalidV2MarkerOnLegacyEvent: LegacyAxlEventV1 = {
  ...explicitlyVersionedLegacyEvent,
  // @ts-expect-error a v2 marker cannot carry a legacy payload
  schemaVersion: 2,
};

const transcriptionV2Event = {
  schemaVersion: 2,
  type: 'transcription_end',
  transcriptionId: 'tr-1',
  executionId: 'exec-1',
  step: 1,
  timestamp: 1,
  duration: 1,
  data: { status: 'completed' as const },
} satisfies AxlEventV2;

// @ts-expect-error transcription is a current v2-only event, never legacy v1
const transcriptionLegacyEvent: LegacyAxlEventV1 = transcriptionV2Event;
void transcriptionLegacyEvent;

function readHistoricalEventVersion(event: HistoricalAxlEvent): 1 | 2 {
  if (event.schemaVersion === 2) return event.schemaVersion;
  return event.schemaVersion ?? 1;
}

const invalidVersionedLegacyExecution: LegacyExecutionInfoV1 = {
  ...legacyExecution,
  // @ts-expect-error legacy rows cannot carry the v2 execution marker
  eventSchemaVersion: 2,
};

// @ts-expect-error accepted v2 lifecycle events always identify their agent
const startWithoutAgent: AxlEventV2 = {
  schemaVersion: 2,
  type: 'tool_call_start',
  executionId: 'exec-1',
  askId: 'ask-1',
  depth: 0,
  step: 1,
  timestamp: 1,
  tool: 'lookup',
  callId: 'call-1',
  data: startData,
  agent: undefined,
};

// @ts-expect-error accepted v2 lifecycle events always identify their agent
const endWithoutAgent: AxlEventV2 = {
  ...endEvent,
  agent: undefined,
};

// @ts-expect-error unavailable rejections require the available tool set
const unavailableWithoutTools: ToolCallRejectedData = {
  reason: 'unavailable',
  requestedTool: 'missing',
};

export {
  afterHandlerWithoutResult,
  assertCancellationExhaustive,
  assertFailureExhaustive,
  assertOutcomeExhaustive,
  assertRejectionExhaustive,
  continuingProjectionFailure,
  deniedEvent,
  deniedWithResult,
  endWithoutAgent,
  explicitlyVersionedLegacyEvent,
  handlerWithoutAttempts,
  histories,
  invalidVersionedLegacyExecution,
  invalidV2MarkerOnLegacyEvent,
  preResultCancellationWithResult,
  startData,
  startWithoutAgent,
  successWithoutResult,
  throwable,
  toolFailure,
  typedToolFailure,
  liveEndEvent,
  retryPredicate,
  readHistoricalEventVersion,
  unversionedV2Event,
  unversionedExecution,
  unavailableWithoutTools,
  versionedLegacyExecution,
  v2WorkflowEvent,
};
