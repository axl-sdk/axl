/** The validated, self-contained consumption form of the additive v1 capture journal. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AxlError } from '../errors.js';
import { REDACTED, redactCapturedRequestPayload } from '../redaction.js';
import type { CapturedJsonValue, CapturedRequestRecord } from './capture.js';

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();
const nonempty = z.string().min(1);
const timestampSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'Expected ISO-8601 timestamp',
  );
function copyStrictJson(value: unknown, ancestors = new WeakSet<object>()): CapturedJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value))
    throw new TypeError('Expected strict JSON value');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Expected plain JSON container');
  ancestors.add(value);
  try {
    if (array) {
      const result: CapturedJsonValue[] = [];
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) throw new TypeError('Expected dense JSON array');
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('Expected array data element');
        result.push(copyStrictJson(descriptor.value, ancestors));
      }
      return result;
    }
    const result: Record<string, CapturedJsonValue> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('JSON object has symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        throw new TypeError('Expected object data property');
      result[key] = copyStrictJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
function copyJsonInput(value: unknown): CapturedJsonValue | typeof z.NEVER {
  try {
    return copyStrictJson(value);
  } catch {
    return z.NEVER;
  }
}
const jsonValueSchema = z.preprocess(
  copyJsonInput,
  z.custom<CapturedJsonValue>((value) => value !== z.NEVER, 'Expected strict JSON value'),
);
const jsonObjectSchema = z.preprocess(copyJsonInput, z.record(z.string(), jsonValueSchema));
const toolCallSchema = z.strictObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.strictObject({ name: z.string(), arguments: z.string() }),
});
const inputPartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), characters: count }),
  z.strictObject({
    type: z.literal('image'),
    source: z.enum(['url', 'bytes', 'base64', 'provider-file']),
    mediaType: z.string().optional(),
    bytes: count.optional(),
    locator: z.string().optional(),
    label: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('audio'),
    source: z.enum(['bytes', 'base64', 'provider-file']),
    mediaType: z.string().optional(),
    bytes: count.optional(),
    locator: z.string().optional(),
    label: z.string().optional(),
  }),
]);
const messageSchema = z.strictObject({
  role: z.string(),
  content: z.string().nullable(),
  input: z.strictObject({ parts: z.array(inputPartSchema) }).optional(),
  name: z.string().optional(),
  agent: z.string().optional(),
  origin: z.literal('runtime').optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  providerMetadata: jsonObjectSchema.optional(),
});
const responseFormatSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text') }),
  z.strictObject({ type: z.literal('json_object') }),
  z.strictObject({
    type: z.literal('json_schema'),
    json_schema: z.strictObject({
      name: z.string(),
      strict: z.boolean().optional(),
      schema: jsonValueSchema,
    }),
  }),
]);
const requestSchema = z.strictObject({
  messages: z.array(messageSchema),
  tools: z
    .array(
      z.strictObject({
        name: z.string(),
        description: z.string().optional(),
        parameters: jsonValueSchema,
        strict: z.boolean().optional(),
      }),
    )
    .optional(),
  responseFormat: responseFormatSchema.optional(),
  options: z.strictObject({
    model: z.string(),
    temperature: finite.optional(),
    maxTokens: finite.optional(),
    effort: z.string().optional(),
    thinkingBudget: finite.optional(),
    includeThoughts: z.boolean().optional(),
    toolChoice: jsonValueSchema.optional(),
    stop: z.array(z.string()).optional(),
    promptCache: z.boolean().optional(),
  }),
  providerOptionKeys: z.array(z.string()).optional(),
});
const responseSchema = z.strictObject({
  content: z.string(),
  thinking: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  finishReason: z
    .enum(['stop', 'length', 'tool_calls', 'content_filter', 'refusal', 'other'])
    .optional(),
  rawFinishReason: z.string().optional(),
  responseId: z.string().optional(),
  responseModel: z.string().optional(),
  providerMetadata: jsonObjectSchema.optional(),
});
const errorSchema = z.strictObject({
  name: z.string().optional(),
  message: z.string(),
  code: z.string().optional(),
  status: finite.optional(),
  retryable: z.boolean().optional(),
  requestId: z.string().optional(),
  retryAfterMs: nonnegative.optional(),
});
const partialSchema = z.strictObject({
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});
const usageSchema = z.strictObject({
  prompt_tokens: count,
  completion_tokens: count,
  total_tokens: count,
  reasoning_tokens: count.optional(),
  cached_tokens: count.optional(),
  cache_write_tokens: count.optional(),
  audio_input_tokens: count.optional(),
  audio_output_tokens: count.optional(),
});
const externalUsageSchema = z.strictObject({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  reasoningTokens: count.optional(),
  cachedTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  audioSeconds: nonnegative.optional(),
});
const timingSchema = z.strictObject({
  queuedMs: nonnegative.optional(),
  attempts: positiveCount.optional(),
  rateLimitRetries: count.optional(),
  retryMs: nonnegative.optional(),
  ttfbMs: nonnegative.optional(),
  firstTokenMs: nonnegative.optional(),
  wireMs: nonnegative.optional(),
  durationMs: nonnegative.optional(),
});
const capturedSchema = z.strictObject({
  fidelity: z.literal('runtime_request'),
  redacted: z.boolean(),
  truncated: z.boolean(),
  continuityCaptured: z.literal(true).optional(),
  omitted: z.array(z.string()),
  replayable: z.boolean(),
  reason: z.string().optional(),
});
const idsSchema = z.strictObject({
  executionId: z.string().optional(),
  workflow: z.string().optional(),
  agent: z.string().optional(),
  askId: z.string().optional(),
  parentAskId: z.string().optional(),
  depth: count.optional(),
  turn: count.optional(),
  sessionId: z.string().optional(),
  caseIndex: count.optional(),
  scorer: z.string().optional(),
});
const gateSchema = z.strictObject({
  retryReason: z.enum(['schema', 'validate', 'guardrail']),
  rejectedCallId: z.string().optional(),
  correction: z
    .strictObject({
      stage: z.enum(['schema', 'validate', 'guardrail']),
      reason: z.string().optional(),
      feedbackMessage: z.string(),
    })
    .optional(),
});
const commonSchema = z.strictObject({
  v: z.literal(2),
  id: nonempty,
  purpose: z.enum(['ask', 'summary', 'judge', 'direct']).optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  ids: idsSchema,
  attributes: z.record(z.string(), z.union([z.string(), finite, z.boolean()])),
  gate: gateSchema.optional(),
  timing: timingSchema.optional(),
  cost: nonnegative.optional(),
  costProvenance: z
    .enum(['provider_reported', 'price_table_estimate', 'adapter_reported', 'caller_reported'])
    .optional(),
  unpriced: z.boolean().optional(),
  captured: capturedSchema,
});
const modelOutcomeSchema = z.union([
  z.strictObject({ status: z.literal('ok'), response: responseSchema }),
  z.strictObject({
    status: z.literal('ok'),
    payloadOmitted: z.literal(true),
    finishReason: z
      .enum(['stop', 'length', 'tool_calls', 'content_filter', 'refusal', 'other'])
      .optional(),
    rawFinishReason: z.string().optional(),
    responseId: z.string().optional(),
    responseModel: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    error: errorSchema,
    partial: partialSchema.optional(),
    payloadOmitted: z.literal(true).optional(),
    termination: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    payloadOmitted: z.literal(true),
    partial: partialSchema.optional(),
    termination: z.string().optional(),
  }),
  z.strictObject({
    status: z.enum(['aborted', 'stalled', 'consumer_closed']),
    partial: partialSchema.optional(),
    payloadOmitted: z.literal(true).optional(),
    termination: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('unfinished'),
    termination: z.string().optional(),
    payloadOmitted: z.literal(true).optional(),
  }),
]);
const externalOutcomeSchema = z.union([
  z.strictObject({ status: z.literal('ok'), payloadOmitted: z.literal(true).optional() }),
  z.strictObject({
    status: z.literal('error'),
    error: errorSchema,
    payloadOmitted: z.literal(true).optional(),
    termination: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    payloadOmitted: z.literal(true),
    termination: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('unfinished'),
    payloadOmitted: z.literal(true).optional(),
    termination: z.string().optional(),
  }),
]);
const modelShape = commonSchema.extend({
  kind: z.enum(['chat', 'stream']),
  provider: nonempty,
  model: nonempty,
  request: requestSchema.optional(),
  outcome: modelOutcomeSchema,
  usage: usageSchema.optional(),
});
const externalShape = commonSchema.extend({
  kind: z.literal('external'),
  name: nonempty,
  costProvenance: z.literal('caller_reported').optional(),
  external: z
    .strictObject({ request: jsonValueSchema.optional(), response: jsonValueSchema.optional() })
    .optional(),
  outcome: externalOutcomeSchema,
  usage: externalUsageSchema.optional(),
});
function messageCanReplay(message: z.infer<typeof messageSchema>): boolean {
  if (!message.input) return message.content !== null;
  if (message.input.parts.some((part) => part.type !== 'text')) return false;
  const characters = message.input.parts.reduce(
    (sum, part) => sum + (part.type === 'text' ? part.characters : 0),
    0,
  );
  return characters === (message.content?.length ?? 0);
}
const modelBodySchema = modelShape.superRefine((record, ctx) => {
  const exact =
    !!record.request &&
    record.captured.continuityCaptured === true &&
    !record.captured.redacted &&
    !record.captured.truncated &&
    record.captured.omitted.length === 0 &&
    !record.request.providerOptionKeys?.length &&
    record.request.messages.every(messageCanReplay);
  if (record.captured.replayable && !exact)
    ctx.addIssue({
      code: 'custom',
      message: 'replayable requires a complete continuity-aware request',
    });
  if (record.outcome.status === 'unfinished' && record.endedAt !== undefined)
    ctx.addIssue({ code: 'custom', message: 'unfinished cannot have an end timestamp' });
});
const externalBodySchema = externalShape.superRefine((record, ctx) => {
  if (record.captured.replayable)
    ctx.addIssue({
      code: 'custom',
      message: 'external operations cannot be replayed as model calls',
    });
  if (record.outcome.status === 'unfinished' && record.endedAt !== undefined)
    ctx.addIssue({ code: 'custom', message: 'unfinished cannot have an end timestamp' });
});
const modelSchema = z.preprocess(copyJsonInput, modelBodySchema);
const externalSchema = z.preprocess(copyJsonInput, externalBodySchema);
/** Validated v2 model call; historical v1 journals are read through foldJournal. */
export const modelCallRecordSchema = modelSchema;
export const externalOperationRecordSchema = externalSchema;
export const foldedOperationRecordSchema = z.union([modelSchema, externalSchema]);
export type ModelCallRecord = z.infer<typeof modelSchema>;
export type ExternalOperationRecord = z.infer<typeof externalSchema>;
export type FoldedOperationRecord = ModelCallRecord | ExternalOperationRecord;

// The v1 journal stays additive. Known fields are validated deeply; unknown future
// optional fields survive at this read boundary without weakening nested values.
const journalBase = z
  .object({
    v: z.literal(1),
    phase: z.enum(['start', 'attempt', 'end']),
    operationId: nonempty,
    caseIndex: count.optional(),
    scorer: z.string().optional(),
    executionId: z.string().optional(),
    workflow: z.string().optional(),
    agent: z.string().optional(),
    depth: count.optional(),
    sessionId: z.string().optional(),
    purpose: z.enum(['ask', 'summary', 'judge', 'direct']).optional(),
    askId: z.string().optional(),
    parentAskId: z.string().optional(),
    turn: count.optional(),
    retryReason: z.enum(['schema', 'validate', 'guardrail']).optional(),
    rejectedCallId: z.string().optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    durationMs: nonnegative.optional(),
    timing: timingSchema.optional(),
    transportAttempts: positiveCount,
    outcomeStatus: z
      .enum(['ok', 'error', 'aborted', 'stalled', 'consumer_closed', 'unfinished'])
      .optional(),
    cost: nonnegative.optional(),
    costProvenance: z
      .enum(['provider_reported', 'price_table_estimate', 'adapter_reported', 'caller_reported'])
      .optional(),
    finishReason: z
      .enum(['stop', 'length', 'tool_calls', 'content_filter', 'refusal', 'other'])
      .optional(),
    rawFinishReason: z.string().optional(),
    responseId: z.string().optional(),
    responseModel: z.string().optional(),
    error: errorSchema.optional(),
    termination: z.string().optional(),
    correction: z
      .strictObject({
        stage: z.enum(['schema', 'validate', 'guardrail']),
        reason: z.string().optional(),
        feedbackMessage: z.string(),
      })
      .optional(),
    captured: capturedSchema.omit({ replayable: true }),
    bytes: count.optional(),
  })
  .catchall(jsonValueSchema);
const modelJournalSchema = journalBase.extend({
  kind: z.enum(['chat', 'stream']),
  provider: nonempty,
  model: nonempty,
  request: requestSchema.optional(),
  response: responseSchema
    .extend({
      usage: usageSchema.optional(),
      cost: nonnegative.optional(),
      costProvenance: z
        .enum(['provider_reported', 'price_table_estimate', 'adapter_reported'])
        .optional(),
      timing: timingSchema.optional(),
    })
    .optional(),
  partial: partialSchema.optional(),
  usage: usageSchema.optional(),
});
const externalJournalSchema = journalBase.extend({
  kind: z.literal('external'),
  name: nonempty,
  usage: externalUsageSchema.optional(),
  external: z
    .strictObject({ request: jsonValueSchema.optional(), response: jsonValueSchema.optional() })
    .optional(),
});
const journalBodySchema = z
  .union([modelJournalSchema, externalJournalSchema])
  .superRefine((line, ctx) => {
    const hasRequest = line.kind !== 'external' && line.request !== undefined;
    const hasResponse = line.kind !== 'external' && line.response !== undefined;
    const hasPartial = line.kind !== 'external' && line.partial !== undefined;
    const hasExternalPayload = line.kind === 'external' && line.external !== undefined;
    const settlementOnly = [
      line.endedAt,
      line.durationMs,
      line.timing,
      line.outcomeStatus,
      line.usage,
      line.cost,
      line.costProvenance,
      line.finishReason,
      line.rawFinishReason,
      line.responseId,
      line.responseModel,
      line.error,
      line.termination,
    ];
    const invalid = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (
      line.phase === 'start' &&
      (settlementOnly.some((value) => value !== undefined) ||
        hasResponse ||
        hasPartial ||
        hasExternalPayload)
    )
      invalid('start line contains settlement data');
    if (
      line.phase === 'attempt' &&
      (hasRequest ||
        hasResponse ||
        hasPartial ||
        hasExternalPayload ||
        settlementOnly.some((value) => value !== undefined))
    )
      invalid('attempt line contains request or settlement data');
    if (line.phase === 'end' && hasRequest) invalid('end line contains a request');
    if (hasResponse && hasPartial) invalid('end line contains both response and partial');
    if (line.error !== undefined && hasResponse)
      invalid('end line contains both response and error');
    if (
      line.kind === 'external' &&
      ['provider', 'model', 'request', 'response', 'partial'].some((key) => key in line)
    )
      invalid('external line contains model fields');
    if (line.kind !== 'external' && ['name', 'external'].some((key) => key in line))
      invalid('model line contains external fields');
  });
export const capturedJournalLineSchema = z.preprocess(copyJsonInput, journalBodySchema);

type JournalLine = z.infer<typeof capturedJournalLineSchema>;
const identityKeys = [
  'kind',
  'provider',
  'model',
  'name',
  'caseIndex',
  'scorer',
  'executionId',
  'workflow',
  'agent',
  'depth',
  'sessionId',
  'purpose',
  'askId',
  'parentAskId',
  'turn',
  'retryReason',
  'rejectedCallId',
] as const;
function fail(message: string): never {
  throw new AxlError('INVALID_CAPTURE_JOURNAL', message);
}
function validateFolded(value: unknown, id: string): FoldedOperationRecord {
  const parsed = foldedOperationRecordSchema.safeParse(value);
  if (!parsed.success) fail(`Invalid folded capture operation ${id}: ${parsed.error.message}`);
  return parsed.data;
}
function terminalStatus(
  end: JournalLine | undefined,
): 'ok' | 'error' | 'aborted' | 'stalled' | 'consumer_closed' | 'unfinished' {
  if (!end) return 'unfinished';
  const termination = end.termination;
  const derived =
    termination === 'aborted' || termination === 'stream aborted by the consumer'
      ? 'aborted'
      : termination === 'stalled'
        ? 'stalled'
        : termination === 'consumer_closed' || termination === 'stream closed by the consumer'
          ? 'consumer_closed'
          : termination === 'stream ended without a done chunk' ||
              termination === 'stream failed to start' ||
              termination === 'stream threw mid-iteration'
            ? 'error'
            : termination !== undefined
              ? undefined
              : end.error
                ? 'error'
                : end.kind !== 'external' && end.response
                  ? 'ok'
                  : end.kind === 'external'
                    ? (end.outcomeStatus ?? 'ok')
                    : undefined;
  if (termination !== undefined && derived === undefined)
    fail(`Unsupported terminal outcome for capture operation ${end.operationId}: ${termination}`);
  if (end.outcomeStatus === 'unfinished')
    fail(`End line cannot be unfinished for capture operation ${end.operationId}`);
  if (derived && end.outcomeStatus && end.outcomeStatus !== derived)
    fail(`Contradictory terminal status for capture operation ${end.operationId}`);
  if (!end.outcomeStatus && !derived)
    fail(
      `Unsupported terminal outcome for capture operation ${end.operationId}: no response or error`,
    );
  if (end.kind === 'external' && derived !== 'ok' && derived !== 'error')
    fail(
      `Unsupported external terminal status for capture operation ${end.operationId}: ${derived}`,
    );
  return (end.outcomeStatus ?? derived)!;
}
/** Assemble interleaved v1 phase lines into one validated v2 operation per id. */
export function foldJournal(
  lines: Iterable<CapturedRequestRecord | unknown>,
): FoldedOperationRecord[] {
  const groups = new Map<
    string,
    { lines: JournalLine[]; start?: JournalLine; end?: JournalLine; attempts: number }
  >();
  let position = 0;
  for (const raw of lines) {
    position++;
    let parsed: ReturnType<typeof capturedJournalLineSchema.safeParse>;
    try {
      parsed = capturedJournalLineSchema.safeParse(raw);
    } catch {
      fail(`Invalid capture journal line ${position}: value could not be inspected`);
    }
    if (!parsed.success) fail(`Invalid capture journal line ${position}: ${parsed.error.message}`);
    const line = parsed.data;
    let group = groups.get(line.operationId);
    if (!group) {
      group = { lines: [], attempts: 0 };
      groups.set(line.operationId, group);
    }
    if (group.lines.some((prior) => isDeepStrictEqual(prior, line))) continue;
    for (const prior of group.lines) {
      if (prior.captured.redacted !== line.captured.redacted)
        fail(
          `Contradictory redaction for capture operation ${line.operationId} at line ${position}`,
        );
      for (const key of identityKeys) {
        const left = (prior as Record<string, unknown>)[key];
        const right = (line as Record<string, unknown>)[key];
        if (left !== undefined && right !== undefined && !isDeepStrictEqual(left, right))
          fail(
            `Contradictory ${key} for capture operation ${line.operationId} at line ${position}`,
          );
      }
    }
    if (line.phase === 'start') {
      if (group.start || group.end || group.lines.length)
        fail(`Contradictory start for capture operation ${line.operationId} at line ${position}`);
      group.start = line;
    } else if (line.phase === 'end') {
      if (group.end)
        fail(`Contradictory end for capture operation ${line.operationId} at line ${position}`);
      group.end = line;
    } else if (group.end) {
      fail(`Attempt after end for capture operation ${line.operationId} at line ${position}`);
    }
    group.attempts = Math.max(
      group.attempts,
      line.transportAttempts ?? 0,
      line.timing?.attempts ?? 0,
    );
    group.lines.push(line);
  }
  const folded: FoldedOperationRecord[] = [];
  for (const [id, group] of groups) {
    const first = group.start ?? group.lines[0]!;
    const end = group.end;
    const latest = end ?? group.lines[group.lines.length - 1]!;
    const field = (key: string): unknown =>
      [...group.lines]
        .reverse()
        .find((line) => (line as Record<string, unknown>)[key] !== undefined)?.[
        key as keyof JournalLine
      ];
    const captured = {
      fidelity: 'runtime_request' as const,
      redacted: group.lines.some((line) => line.captured.redacted),
      truncated: group.lines.some((line) => line.captured.truncated),
      ...(group.start?.captured.continuityCaptured === true
        ? { continuityCaptured: true as const }
        : {}),
      omitted: [...new Set(group.lines.flatMap((line) => line.captured.omitted))],
      ...(latest.captured.reason !== undefined ? { reason: latest.captured.reason } : {}),
      replayable: false,
    };
    const timing = {
      ...(end?.timing ?? (end?.kind !== 'external' ? end?.response?.timing : undefined) ?? {}),
      ...(end?.durationMs !== undefined ? { durationMs: end.durationMs } : {}),
    };
    if (group.attempts > 0) timing.attempts = group.attempts;
    const status = terminalStatus(end);
    if (
      end &&
      ((status === 'ok' &&
        (end.error ||
          end.termination === 'aborted' ||
          end.termination === 'stalled' ||
          end.termination === 'consumer_closed')) ||
        (status === 'error' && end.kind !== 'external' && end.response) ||
        ((status === 'aborted' || status === 'stalled' || status === 'consumer_closed') &&
          end.kind !== 'external' &&
          end.response))
    )
      fail(`Contradictory outcome for capture operation ${id}`);
    const stubbedEnd = !!end && (end.captured.truncated || end.captured.omitted.includes('record'));
    const retryReason = field('retryReason');
    const correction = field('correction');
    const rejectedCallId = field('rejectedCallId');
    if (correction !== undefined && retryReason === undefined)
      fail(`Correction without retry reason for capture operation ${id}`);
    const common = {
      v: 2 as const,
      id,
      ...(field('purpose') !== undefined ? { purpose: field('purpose') } : {}),
      ...(field('startedAt') !== undefined ? { startedAt: field('startedAt') } : {}),
      ...(end?.endedAt !== undefined ? { endedAt: end.endedAt } : {}),
      ids: Object.fromEntries(
        (
          [
            'executionId',
            'workflow',
            'agent',
            'askId',
            'parentAskId',
            'depth',
            'turn',
            'sessionId',
            'caseIndex',
            'scorer',
          ] as const
        ).flatMap((key) => {
          const value = field(key);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      attributes: {},
      ...(retryReason !== undefined
        ? {
            gate: {
              retryReason,
              ...(rejectedCallId !== undefined ? { rejectedCallId } : {}),
              ...(correction !== undefined ? { correction } : {}),
            },
          }
        : {}),
      ...(Object.keys(timing).length ? { timing } : {}),
      ...((end?.cost ?? (end?.kind !== 'external' ? end?.response?.cost : undefined)) !== undefined
        ? { cost: end?.cost ?? (end?.kind !== 'external' ? end?.response?.cost : undefined) }
        : {}),
      ...((end?.costProvenance ??
        (end?.kind !== 'external' ? end?.response?.costProvenance : undefined)) !== undefined
        ? {
            costProvenance:
              end?.costProvenance ??
              (end?.kind !== 'external' ? end?.response?.costProvenance : undefined),
          }
        : {}),
      captured,
    };
    if (first.kind === 'external') {
      const outcome = !end
        ? { status: 'unfinished' as const }
        : status === 'error'
          ? {
              status: 'error' as const,
              ...(end.error ? { error: end.error } : {}),
              ...(stubbedEnd || !end.error ? { payloadOmitted: true as const } : {}),
              ...(end.termination ? { termination: end.termination } : {}),
            }
          : { status: 'ok' as const, ...(stubbedEnd ? { payloadOmitted: true as const } : {}) };
      folded.push(
        validateFolded(
          {
            ...common,
            kind: 'external',
            name: first.name,
            ...(end?.kind === 'external' && end.external ? { external: end.external } : {}),
            ...(end?.usage ? { usage: end.usage } : {}),
            outcome,
          },
          id,
        ),
      );
      continue;
    }
    const request = group.start?.kind !== 'external' ? group.start?.request : undefined;
    captured.replayable =
      !!request &&
      captured.continuityCaptured === true &&
      !captured.redacted &&
      !captured.truncated &&
      captured.omitted.length === 0 &&
      !request.providerOptionKeys?.length &&
      request.messages.every(messageCanReplay);
    const outcome = !end
      ? { status: 'unfinished' as const }
      : status === 'ok'
        ? end.kind !== 'external' && end.response && !stubbedEnd
          ? {
              status: 'ok' as const,
              response: Object.fromEntries(
                Object.entries(end.response).filter(
                  ([key]) => !['usage', 'cost', 'costProvenance', 'timing'].includes(key),
                ),
              ),
            }
          : {
              status: 'ok' as const,
              payloadOmitted: true as const,
              ...(end.finishReason !== undefined ? { finishReason: end.finishReason } : {}),
              ...(end.rawFinishReason !== undefined
                ? { rawFinishReason: end.rawFinishReason }
                : {}),
              ...(end.responseId !== undefined ? { responseId: end.responseId } : {}),
              ...(end.responseModel !== undefined ? { responseModel: end.responseModel } : {}),
            }
        : status === 'error'
          ? {
              status: 'error' as const,
              ...(end.error ? { error: end.error } : {}),
              ...(end.kind !== 'external' && end.partial ? { partial: end.partial } : {}),
              ...(stubbedEnd || !end.error ? { payloadOmitted: true as const } : {}),
              ...(end.termination ? { termination: end.termination } : {}),
            }
          : {
              status,
              ...(end.kind !== 'external' && end.partial ? { partial: end.partial } : {}),
              ...(stubbedEnd ? { payloadOmitted: true as const } : {}),
              ...(end.termination ? { termination: end.termination } : {}),
            };
    folded.push(
      validateFolded(
        {
          ...common,
          kind: first.kind,
          provider: first.provider,
          model: first.model,
          ...(request ? { request } : {}),
          ...((end?.usage ?? (end?.kind !== 'external' ? end?.response?.usage : undefined))
            ? { usage: end?.usage ?? (end?.kind !== 'external' ? end?.response?.usage : undefined) }
            : {}),
          outcome,
        },
        id,
      ),
    );
  }
  return folded;
}

/** Return a redacted copy while retaining correlation, timing, usage and cost. */
export function redactModelCallRecord<T extends FoldedOperationRecord>(record: T): T {
  const copy = structuredClone(record);
  copy.captured.redacted = true;
  copy.captured.replayable = false;
  if (copy.captured.reason !== undefined) copy.captured.reason = REDACTED;
  if (copy.kind === 'external') {
    if (copy.external?.request !== undefined) copy.external.request = REDACTED;
    if (copy.external?.response !== undefined) copy.external.response = REDACTED;
    if (copy.outcome.status === 'error' && 'error' in copy.outcome && copy.outcome.error)
      copy.outcome.error.message = REDACTED;
  } else {
    if (copy.request) {
      if (copy.request.messages.some((message) => message.providerMetadata !== undefined))
        copy.captured.omitted.push('providerMetadata');
      copy.request = redactCapturedRequestPayload(copy.request);
    }
    if (copy.outcome.status === 'ok' && 'response' in copy.outcome) {
      copy.outcome.response.content = REDACTED;
      if (copy.outcome.response.thinking !== undefined) copy.outcome.response.thinking = REDACTED;
      if (copy.outcome.response.providerMetadata !== undefined) {
        delete copy.outcome.response.providerMetadata;
        copy.captured.omitted.push('providerMetadata');
      }
      for (const call of copy.outcome.response.tool_calls ?? []) call.function.arguments = REDACTED;
    } else if (copy.outcome.status === 'error') {
      if ('error' in copy.outcome && copy.outcome.error) copy.outcome.error.message = REDACTED;
      if (copy.outcome.partial) {
        if (copy.outcome.partial.content !== undefined) copy.outcome.partial.content = REDACTED;
        if (copy.outcome.partial.thinking !== undefined) copy.outcome.partial.thinking = REDACTED;
        for (const call of copy.outcome.partial.tool_calls ?? [])
          call.function.arguments = REDACTED;
      }
    } else if ('partial' in copy.outcome && copy.outcome.partial) {
      if (copy.outcome.partial.content !== undefined) copy.outcome.partial.content = REDACTED;
      if (copy.outcome.partial.thinking !== undefined) copy.outcome.partial.thinking = REDACTED;
      for (const call of copy.outcome.partial.tool_calls ?? []) call.function.arguments = REDACTED;
    }
  }
  if (copy.gate?.correction) {
    if (copy.gate.correction.reason !== undefined) copy.gate.correction.reason = REDACTED;
    copy.gate.correction.feedbackMessage = REDACTED;
  }
  copy.captured.omitted = [...new Set(copy.captured.omitted)];
  return copy;
}
