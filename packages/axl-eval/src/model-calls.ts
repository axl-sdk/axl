/** Turn validated capture records into ordinary eval inputs and executors. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AxlError,
  capturedJournalLineSchema,
  foldJournal,
  foldedOperationRecordSchema,
  modelCallRecordSchema,
  type ChatMessage,
  type ChatOptions,
  type EvalExecuteWorkflow,
  type FinishReason,
  type FoldedOperationRecord,
  type ModelCallRecord,
  type ProviderResponse,
  type StreamChunk,
  type ToolCallMessage,
} from '@axlsdk/axl';
import { dataset, type Dataset } from './dataset.js';

export type ModelCallInput = {
  request?: ModelCallRecord['request'];
  ids: ModelCallRecord['ids'];
  attributes: ModelCallRecord['attributes'];
  recorded: ModelCallRecord;
};

export type ModelCallDatasetOptions<TAnnotations> = {
  /** Runs after validation, including on external operations. */
  filter?: (record: FoldedOperationRecord) => boolean;
  /** Attach ground truth for scorers without changing their signature. */
  annotate?: (record: ModelCallRecord, index: number) => TAnnotations;
};

export type ReplayModelCallOptions = { model?: string };

/**
 * The `output` both executors return: one model response, field-named like a
 * recorded `ok` outcome's `response` so a scorer can compare a replay with
 * `input.recorded` directly. Tool calls are part of the answer, not dropped.
 */
export type ModelCallOutput = {
  content: string;
  /** Parsed `content`, present when the request asked for JSON and the model answered in text. */
  json?: unknown;
  thinking?: string;
  tool_calls?: ToolCallMessage[];
  finishReason?: FinishReason;
  rawFinishReason?: string;
  responseId?: string;
  responseModel?: string;
};

type Located = { value: unknown; location: string; position: number };
function invalid(location: string, message: string): never {
  throw new AxlError('INVALID_MODEL_CALL_SOURCE', `${location}: ${message}`);
}
function versionOf(value: unknown): unknown {
  return value !== null && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, 'v')?.value
    : undefined;
}
function parseJson(value: string, location: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid(location, 'invalid JSON');
  }
}
function arrayLength(source: unknown, location: string): number {
  let array: boolean;
  let descriptor: PropertyDescriptor | undefined;
  try {
    array = Array.isArray(source);
    if (array) descriptor = Object.getOwnPropertyDescriptor(source, 'length');
  } catch {
    return invalid(location, 'array could not be inspected');
  }
  if (!array || !descriptor || !('value' in descriptor)) invalid(location, 'expected an array');
  const length: unknown = descriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    invalid(location, 'invalid array length');
  return length;
}
function arraySlot(source: readonly unknown[], index: number, location: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, String(index));
  } catch {
    return invalid(location, 'array entry could not be inspected');
  }
  if (!descriptor || !('value' in descriptor))
    invalid(location, 'array entry is missing or is an accessor');
  return descriptor.value;
}
function* locateArray(
  source: readonly unknown[],
  at: (index: number) => string,
): Iterable<Located> {
  const length = arrayLength(source, 'source');
  for (let index = 0; index < length; index++) {
    const location = at(index);
    yield { value: arraySlot(source, index, location), position: index, location };
  }
}

/** Read v2 records or v1 phase journals without dropping external operations. */
export async function loadModelCalls(
  source: string | readonly unknown[],
): Promise<FoldedOperationRecord[]> {
  let located: Iterable<Located>;
  if (typeof source === 'string') {
    const content = (await readFile(source, 'utf8')).replace(/^\uFEFF/, '');
    if (content.trimStart().startsWith('[')) {
      const parsed = parseJson(content, `file ${source}`);
      if (!Array.isArray(parsed)) invalid(`file ${source}`, 'expected a JSON array');
      located = locateArray(parsed, (index) => `entry ${index + 1} of ${source}`);
    } else {
      const rows = content.split(/\r?\n/);
      if (content.endsWith('\n')) rows.pop(); // one final line terminator is not a blank record
      located = rows.flatMap((row, index) => {
        const location = `line ${index + 1} of ${source}`;
        if (row.trim() === '') return [];
        return [{ value: parseJson(row, location), position: index, location }];
      });
    }
  } else {
    located = locateArray(source, (index) => `item ${index + 1}`);
  }

  const journal: Array<Located & { operationId: string }> = [];
  const folded: Array<{ record: FoldedOperationRecord; location: string; position: number }> = [];
  const firstJournal = new Map<string, Located>();
  let format: 1 | 2 | undefined;
  for (const entry of located) {
    let version: unknown;
    try {
      version = versionOf(entry.value);
    } catch {
      invalid(entry.location, 'record version could not be inspected');
    }
    if (version === 1 || version === 2) {
      if (format !== undefined && format !== version)
        invalid(entry.location, 'one source cannot mix v1 journal lines with v2 records');
      format = version;
    }
    if (version === 1) {
      const parsed = capturedJournalLineSchema.safeParse(entry.value);
      if (!parsed.success) invalid(entry.location, parsed.error.message);
      journal.push({ ...entry, value: parsed.data, operationId: parsed.data.operationId });
      if (!firstJournal.has(parsed.data.operationId))
        firstJournal.set(parsed.data.operationId, entry);
    } else if (version === 2) {
      const parsed = foldedOperationRecordSchema.safeParse(entry.value);
      if (!parsed.success) invalid(entry.location, parsed.error.message);
      folded.push({ record: parsed.data, location: entry.location, position: entry.position });
    } else {
      invalid(entry.location, 'unsupported capture version');
    }
  }
  if (journal.length) {
    let records: FoldedOperationRecord[];
    try {
      records = foldJournal(journal.map((entry) => entry.value));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line =
        /\bat line (\d+)\b/.exec(message) ?? /^Invalid capture journal line (\d+):/.exec(message);
      const indexed = line ? journal[Number(line[1]) - 1] : undefined;
      const matched =
        indexed ??
        [...journal].reverse().find((entry) => {
          const marker = `capture operation ${entry.operationId}`;
          const at = message.indexOf(marker);
          if (at < 0) return false;
          const suffix = message.slice(at + marker.length);
          return suffix === '' || suffix.startsWith(':') || suffix.startsWith(' at line');
        });
      invalid(matched?.location ?? journal[0].location, message);
    }
    for (const record of records) {
      const first = firstJournal.get(record.id)!;
      folded.push({ record, location: first.location, position: first.position });
    }
  }
  folded.sort((a, b) => a.position - b.position);
  const seen = new Map<string, string>();
  for (const item of folded) {
    const previous = seen.get(item.record.id);
    if (previous)
      invalid(item.location, `duplicate operation id ${item.record.id} (first at ${previous})`);
    seen.set(item.record.id, item.location);
  }
  return folded.map((item) => item.record);
}

const modelCallInputSchema = z.object({ recorded: modelCallRecordSchema }).transform(
  ({ recorded }): ModelCallInput => ({
    ...(recorded.request ? { request: recorded.request } : {}),
    ids: recorded.ids,
    attributes: recorded.attributes,
    recorded,
  }),
);

/** Create an ordinary Dataset for runEval/defineEval; external operations require an explicit filter. */
export function modelCallDataset<TAnnotations = undefined>(
  records: readonly FoldedOperationRecord[],
  options?: ModelCallDatasetOptions<TAnnotations>,
): Dataset<ModelCallInput, TAnnotations> {
  const items: Array<{ input: ModelCallInput; annotations?: TAnnotations }> = [];
  const length = arrayLength(records, 'records');
  for (let index = 0; index < length; index++) {
    const parsed = foldedOperationRecordSchema.safeParse(
      arraySlot(records, index, `record ${index + 1}`),
    );
    if (!parsed.success) invalid(`record ${index + 1}`, parsed.error.message);
    const record = parsed.data;
    if (options?.filter && !options.filter(record)) continue;
    if (record.kind === 'external')
      throw new AxlError(
        'MODEL_CALL_EXPECTED',
        `record ${index + 1} (${record.id}) is external; supply a filter to exclude it`,
      );
    const input: ModelCallInput = {
      ...(record.request ? { request: record.request } : {}),
      ids: record.ids,
      attributes: record.attributes,
      recorded: record,
    };
    items.push({
      input,
      ...(options?.annotate ? { annotations: options.annotate(record, index) } : {}),
    });
  }
  return dataset({
    name: 'model-calls',
    schema: modelCallInputSchema,
    annotations: z.custom<TAnnotations>(),
    items,
  });
}

function readInput(input: unknown): ModelCallRecord {
  const candidate =
    input !== null && typeof input === 'object'
      ? Object.getOwnPropertyDescriptor(input, 'recorded')?.value
      : undefined;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    Object.getOwnPropertyDescriptor(candidate, 'kind')?.value === 'external'
  )
    throw new AxlError(
      'MODEL_CALL_EXPECTED',
      'external operations cannot be scored or replayed as model calls',
    );
  const parsed = modelCallRecordSchema.safeParse(candidate);
  if (!parsed.success)
    throw new AxlError(
      'INVALID_MODEL_CALL_INPUT',
      `expected a validated model-call input: ${parsed.error.message}`,
    );
  return parsed.data;
}
type ResponseFields = Omit<ModelCallOutput, 'json'>;
function modelCallOutput(response: ResponseFields, record: ModelCallRecord): ModelCallOutput {
  const output: ModelCallOutput = {
    content: response.content,
    ...(response.thinking ? { thinking: response.thinking } : {}),
    ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}),
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
    ...(response.rawFinishReason !== undefined
      ? { rawFinishReason: response.rawFinishReason }
      : {}),
    ...(response.responseId !== undefined ? { responseId: response.responseId } : {}),
    ...(response.responseModel !== undefined ? { responseModel: response.responseModel } : {}),
  };
  const format = record.request?.responseFormat?.type;
  if (format !== 'json_object' && format !== 'json_schema') return output;
  // A tool-call turn under a JSON format legitimately carries no text yet.
  if (output.content === '' && output.tool_calls) return output;
  try {
    return { ...output, json: JSON.parse(output.content) as unknown };
  } catch {
    throw new AxlError(
      'INVALID_MODEL_CALL_JSON',
      `model call ${record.id} did not return valid JSON`,
    );
  }
}
function providerOutput(response: ProviderResponse, record: ModelCallRecord): ModelCallOutput {
  return modelCallOutput(
    {
      content: response.content,
      ...(response.thinking_content !== undefined ? { thinking: response.thinking_content } : {}),
      ...(response.tool_calls !== undefined ? { tool_calls: response.tool_calls } : {}),
      ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
      ...(response.rawFinishReason !== undefined
        ? { rawFinishReason: response.rawFinishReason }
        : {}),
      ...(response.responseId !== undefined ? { responseId: response.responseId } : {}),
      ...(response.responseModel !== undefined ? { responseModel: response.responseModel } : {}),
    },
    record,
  );
}

/** Rescore captured output (a {@link ModelCallOutput}) without calling a provider or returning historical cost. */
export function recordedModelCall(): EvalExecuteWorkflow {
  return async (input) => {
    const record = readInput(input);
    if (record.captured.redacted)
      throw new AxlError('RECORDED_OUTPUT_UNAVAILABLE', `model call ${record.id} was redacted`);
    if (record.outcome.status !== 'ok' || !('response' in record.outcome))
      throw new AxlError(
        'RECORDED_OUTPUT_UNAVAILABLE',
        `model call ${record.id} has no complete successful output (${record.outcome.status})`,
      );
    // Copies named response fields only; opaque providerMetadata is replay input, not output.
    return { output: modelCallOutput(record.outcome.response, record) };
  };
}

function replayRequest(record: ModelCallRecord): NonNullable<ModelCallRecord['request']> {
  const request = record.request;
  if (
    !request ||
    !record.captured.replayable ||
    record.captured.continuityCaptured !== true ||
    record.captured.redacted ||
    record.captured.truncated ||
    record.captured.omitted.length > 0 ||
    (request.providerOptionKeys?.length ?? 0) > 0
  )
    throw new AxlError(
      'MODEL_CALL_NOT_REPLAYABLE',
      `model call ${record.id} does not contain an exact replayable request`,
    );
  return request;
}
function chatOptions(request: NonNullable<ModelCallRecord['request']>, model: string): ChatOptions {
  if (!request.options.model)
    throw new AxlError('INVALID_MODEL_CALL_INPUT', 'captured request model is empty');
  const effort = request.options.effort;
  if (effort !== undefined && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
    throw new AxlError('INVALID_MODEL_CALL_INPUT', `unsupported captured effort ${effort}`);
  const toolChoice = request.options.toolChoice;
  if (
    toolChoice !== undefined &&
    toolChoice !== 'auto' &&
    toolChoice !== 'none' &&
    toolChoice !== 'required' &&
    !(
      toolChoice !== null &&
      typeof toolChoice === 'object' &&
      !Array.isArray(toolChoice) &&
      toolChoice.type === 'function' &&
      Object.keys(toolChoice).every((key) => key === 'type' || key === 'function') &&
      toolChoice.function !== null &&
      typeof toolChoice.function === 'object' &&
      !Array.isArray(toolChoice.function) &&
      typeof toolChoice.function.name === 'string' &&
      Object.keys(toolChoice.function).every((key) => key === 'name')
    )
  )
    throw new AxlError('INVALID_MODEL_CALL_INPUT', 'unsupported captured tool choice');
  return {
    model,
    ...(request.options.temperature !== undefined
      ? { temperature: request.options.temperature }
      : {}),
    ...(request.options.maxTokens !== undefined ? { maxTokens: request.options.maxTokens } : {}),
    ...(request.options.thinkingBudget !== undefined
      ? { thinkingBudget: request.options.thinkingBudget }
      : {}),
    ...(request.options.includeThoughts !== undefined
      ? { includeThoughts: request.options.includeThoughts }
      : {}),
    ...(request.options.stop !== undefined ? { stop: [...request.options.stop] } : {}),
    ...(request.options.promptCache !== undefined
      ? { promptCache: request.options.promptCache }
      : {}),
    ...(effort !== undefined ? { effort: effort as ChatOptions['effort'] } : {}),
    ...(toolChoice !== undefined ? { toolChoice: toolChoice as ChatOptions['toolChoice'] } : {}),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description ?? '',
              parameters: tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            },
          })),
        }
      : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
  };
}
function chatMessages(request: NonNullable<ModelCallRecord['request']>): ChatMessage[] {
  return request.messages.map((message) => {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role))
      throw new AxlError('MODEL_CALL_NOT_REPLAYABLE', 'captured message cannot be reconstructed');
    let content: ChatMessage['content'];
    if (message.input) {
      const text = message.content ?? '';
      let offset = 0;
      const parts: Array<{ type: 'text'; text: string }> = [];
      for (const part of message.input.parts) {
        if (part.type !== 'text' || offset + part.characters > text.length)
          throw new AxlError(
            'MODEL_CALL_NOT_REPLAYABLE',
            'captured content parts cannot be reconstructed',
          );
        parts.push({ type: 'text', text: text.slice(offset, offset + part.characters) });
        offset += part.characters;
      }
      if (offset !== text.length)
        throw new AxlError(
          'MODEL_CALL_NOT_REPLAYABLE',
          'captured text lengths do not match content',
        );
      content = parts;
    } else if (message.content !== null) {
      content = message.content;
    } else {
      throw new AxlError('MODEL_CALL_NOT_REPLAYABLE', 'captured message content is absent');
    }
    return {
      role: message.role as ChatMessage['role'],
      content,
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.agent !== undefined ? { agent: message.agent } : {}),
      ...(message.origin !== undefined ? { origin: message.origin } : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.providerMetadata !== undefined
        ? { providerMetadata: message.providerMetadata }
        : {}),
    };
  });
}

/** Replay one captured provider call into a {@link ModelCallOutput}; returned tool calls are not executed. */
export function replayModelCall(options: ReplayModelCallOptions = {}): EvalExecuteWorkflow {
  return async (input, runtime) => {
    const record = readInput(input);
    const request = replayRequest(record); // reject before resolving or dispatching
    const messages = chatMessages(request);
    const capturedOptions = chatOptions(request, request.options.model);
    if (!runtime)
      throw new AxlError('MODEL_CALL_RUNTIME_REQUIRED', 'replay requires an AxlRuntime');
    const uri = options.model ?? `${record.provider}:${request.options.model}`;
    if (!uri.includes(':'))
      throw new AxlError('MODEL_CALL_MODEL_UNRESOLVED', 'model override must use provider:model');
    let resolved: ReturnType<typeof runtime.resolveProvider>;
    try {
      resolved = runtime.resolveProvider(uri);
    } catch {
      throw new AxlError(
        'MODEL_CALL_MODEL_UNRESOLVED',
        `cannot resolve ${uri}; supply an explicit provider:model override`,
      );
    }
    if (!options.model && resolved.provider.name !== record.provider)
      throw new AxlError(
        'MODEL_CALL_MODEL_UNRESOLVED',
        `resolved ${uri} to a different provider; supply an explicit override`,
      );
    const callOptions = {
      ...capturedOptions,
      model: options.model ? resolved.model : request.options.model,
    };
    if (record.kind === 'chat') {
      const response = await resolved.provider.chat(messages, callOptions);
      return { output: providerOutput(response, record) };
    }
    let content = '';
    let thinking = '';
    // Same accumulation as the ask loop: deltas keyed by id, name set, arguments appended.
    const calls = new Map<string, { id: string; name: string; arguments: string }>();
    let done: Extract<StreamChunk, { type: 'done' }> | undefined;
    for await (const chunk of resolved.provider.stream(messages, callOptions)) {
      if (chunk.type === 'text_delta') content += chunk.content;
      else if (chunk.type === 'thinking_delta') thinking += chunk.content;
      else if (chunk.type === 'tool_call_delta') {
        const call = calls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' };
        if (chunk.name) call.name = chunk.name;
        if (chunk.arguments) call.arguments += chunk.arguments;
        calls.set(chunk.id, call);
      } else if (chunk.type === 'done') {
        done = chunk;
        break;
      }
    }
    if (!done)
      throw new AxlError('MODEL_CALL_STREAM_INCOMPLETE', 'replayed stream ended without done');
    return {
      output: providerOutput(
        {
          content,
          ...(thinking ? { thinking_content: thinking } : {}),
          ...(calls.size
            ? {
                tool_calls: [...calls.values()].map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
          ...(done.finishReason !== undefined ? { finishReason: done.finishReason } : {}),
          ...(done.rawFinishReason !== undefined ? { rawFinishReason: done.rawFinishReason } : {}),
          ...(done.responseId !== undefined ? { responseId: done.responseId } : {}),
          ...(done.responseModel !== undefined ? { responseModel: done.responseModel } : {}),
        },
        record,
      ),
    };
  };
}
