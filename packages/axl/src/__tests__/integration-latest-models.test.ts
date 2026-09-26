import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { WorkflowContext } from '../context.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { OpenAIProvider } from '../providers/openai.js';
import { ProviderRegistry } from '../providers/registry.js';
import { XAI_PROFILE } from '../providers/profiles/xai.js';
import { tool } from '../tool.js';
import type { AxlEvent } from '../types.js';
import { z } from 'zod';
import type {
  ChatMessage,
  Provider,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
} from '../providers/types.js';

const prompt: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly: ok' }];
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'acceptance_probe',
      description: 'Return the fixed acceptance-test value.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

async function collectDone(
  chunks: AsyncGenerator<StreamChunk>,
): Promise<Extract<StreamChunk, { type: 'done' }>> {
  let done: Extract<StreamChunk, { type: 'done' }> | undefined;
  for await (const chunk of chunks) {
    if (chunk.type === 'done') done = chunk;
  }
  expect(done).toBeDefined();
  return done!;
}

function expectMetered(response: ProviderResponse, cost: 'static' | 'reported'): void {
  expect(response.content.trim().length).toBeGreaterThan(0);
  expect(response.usage?.total_tokens).toBeGreaterThan(0);
  expect(response.cost).toBeTypeOf('number');
  if (cost === 'static') expect(response.cost).toBeGreaterThan(0);
  else expect(response.cost).toBeGreaterThanOrEqual(0);
}

async function toolContinuation(
  provider: Provider,
  model: string,
  cost: 'static' | 'reported',
): Promise<void> {
  const first = await provider.chat(
    [{ role: 'user', content: 'Call acceptance_probe now. Do not answer directly.' }],
    {
      model,
      maxTokens: 256,
      tools,
      toolChoice: { type: 'function', function: { name: 'acceptance_probe' } },
    },
  );
  expect(first.tool_calls).toHaveLength(1);

  const continuation: ChatMessage[] = [
    { role: 'user', content: 'Call acceptance_probe now. Do not answer directly.' },
    {
      role: 'assistant',
      content: first.content,
      tool_calls: first.tool_calls,
      providerMetadata: first.providerMetadata,
    },
    {
      role: 'tool',
      content: 'accepted',
      tool_call_id: first.tool_calls![0].id,
    },
  ];
  const second = await provider.chat(continuation, { model, maxTokens: 128, tools });
  expect(second.usage?.total_tokens).toBeGreaterThan(0);
  expect(second.cost).toBeTypeOf('number');
  if (cost === 'static') expect(second.cost).toBeGreaterThan(0);
  else expect(second.cost).toBeGreaterThanOrEqual(0);
}

describe.skipIf(!process.env.OPENAI_API_KEY)('latest models: OpenAI live acceptance', () => {
  let chat: OpenAIProvider;
  let responses: OpenAIResponsesProvider;
  beforeAll(() => {
    chat = new OpenAIProvider();
    responses = new OpenAIResponsesProvider();
  });

  // Paid exact-model certification. Keep this file outside the routine live
  // suite; the frontier gate runs only after an explicit spend decision.
  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'GPT-6 Responses text and schema accept %s',
    async (model) => {
      expectMetered(await responses.chat(prompt, { model, maxTokens: 64 }), 'static');
      const schema = await responses.chat([{ role: 'user', content: 'Return the status ok.' }], {
        model,
        maxTokens: 128,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'status',
            strict: true,
            schema: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['ok'] } },
              required: ['status'],
              additionalProperties: false,
            },
          },
        },
      });
      expect(JSON.parse(schema.content)).toEqual({ status: 'ok' });
      expect(schema.usage?.total_tokens).toBeGreaterThan(0);
      expect(schema.cost).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'GPT-6 Responses tool continuation accepts %s',
    async (model) => {
      await toolContinuation(responses, model, 'static');
    },
    180_000,
  );

  it('GPT-6 Responses stream returns terminal usage', async () => {
    const done = await collectDone(
      responses.stream(prompt, { model: 'gpt-6-luna', maxTokens: 64 }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 120_000);

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'GPT-6 Chat text accepts %s',
    async (model) => {
      expectMetered(await chat.chat(prompt, { model, maxTokens: 64 }), 'static');
    },
    120_000,
  );

  it.each(['gpt-6-sol', 'gpt-6-luna'])(
    'GPT-6 Chat tools accept %s at explicit none',
    async (model) => {
      const response = await chat.chat([{ role: 'user', content: 'Call acceptance_probe now.' }], {
        model,
        maxTokens: 64,
        effort: 'none',
        tools,
        toolChoice: { type: 'function', function: { name: 'acceptance_probe' } },
      });
      expect(response.tool_calls?.[0]?.function.name).toBe('acceptance_probe');
      expect(response.usage?.total_tokens).toBeGreaterThan(0);
    },
    120_000,
  );

  it.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'Chat non-stream accepts exact model %s',
    async (model) => {
      expectMetered(await chat.chat(prompt, { model, maxTokens: 32, effort: 'none' }), 'static');
    },
    60_000,
  );

  afterEach(() => vi.restoreAllMocks());

  // Owner remediation row: a portable temperature under the default (active)
  // effort must be stripped from the wire, not rejected, and the provider must
  // accept the resulting body on both endpoints.
  it.each([
    ['openai', 'gpt-6-astra'],
    ['openai', 'gpt-6-sol'],
    ['openai', 'gpt-6-luna'],
    ['openai-responses', 'gpt-6-astra'],
    ['openai-responses', 'gpt-6-sol'],
    ['openai-responses', 'gpt-6-luna'],
  ] as const)(
    'GPT-6 %s strips a portable temperature under default effort for %s',
    async (endpoint, model) => {
      const bodies: Array<Record<string, unknown>> = [];
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return originalFetch(input, init);
      });
      const provider = endpoint === 'openai' ? chat : responses;
      const response = await provider.chat(prompt, { model, maxTokens: 64, temperature: 0.2 });
      expectMetered(response, 'static');
      expect(bodies).toHaveLength(1);
      expect(bodies[0].model).toBe(model);
      expect(bodies[0]).not.toHaveProperty('temperature');
      expect(bodies[0]).not.toHaveProperty('top_p');
      // Default effort is active reasoning; no explicit effort was sent.
      const effort =
        endpoint === 'openai'
          ? bodies[0].reasoning_effort
          : (bodies[0].reasoning as { effort?: unknown } | undefined)?.effort;
      expect(effort).toBeUndefined();
    },
    120_000,
  );

  it('Responses non-stream accepts gpt-5.6-luna with native max', async () => {
    expectMetered(
      await responses.chat(prompt, { model: 'gpt-5.6-luna', maxTokens: 64, effort: 'max' }),
      'static',
    );
  }, 60_000);

  it('Chat stream returns terminal metered usage for gpt-5.6-luna', async () => {
    const done = await collectDone(
      chat.stream(prompt, { model: 'gpt-5.6-luna', maxTokens: 32, effort: 'none' }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 60_000);

  it('Responses stream returns terminal metered usage for gpt-5.6-luna', async () => {
    const done = await collectDone(
      responses.stream(prompt, { model: 'gpt-5.6-luna', maxTokens: 32, effort: 'none' }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 60_000);

  it('Responses tool continuation succeeds on gpt-5.6-luna', async () => {
    await toolContinuation(responses, 'gpt-5.6-luna', 'static');
  }, 120_000);
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('latest models: Anthropic live acceptance', () => {
  let provider: AnthropicProvider;
  let additionalTransportAttempts = 0;
  beforeAll(() => {
    provider = new AnthropicProvider();
  });
  afterEach(() => vi.restoreAllMocks());

  const boundedFetch = (onBody?: (body: Record<string, unknown>) => void) => {
    const configuredLimit = process.env.AXL_FRONTIER_REMAINING_ATTEMPTS ?? '12';
    const parsedLimit = Number(configuredLimit);
    if (!configuredLimit.trim() || !Number.isSafeInteger(parsedLimit) || parsedLimit < 0) {
      throw new Error('AXL_FRONTIER_REMAINING_ATTEMPTS must be a nonnegative integer');
    }
    const attemptLimit = Math.min(12, parsedLimit);
    const originalFetch = globalThis.fetch;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (additionalTransportAttempts >= attemptLimit) {
        throw new Error('Frontier Anthropic extension reached its transport-attempt ceiling');
      }
      additionalTransportAttempts++;
      onBody?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return originalFetch(input, init);
    });
  };

  it('Opus 5.5 text and terminal stream use the exact model with metered Standard cost', async () => {
    const text = await provider.chat(prompt, {
      model: 'claude-opus-5-5',
      maxTokens: 128,
      effort: 'low',
    });
    expectMetered(text, 'static');
    const done = await collectDone(
      provider.stream(prompt, { model: 'claude-opus-5-5', maxTokens: 128, effort: 'low' }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 180_000);

  it('Opus 5.5 auto tool continuation retains signed blocks and reports an edited-prefix reset', async () => {
    const model = 'claude-opus-5-5';
    const initial: ChatMessage[] = [
      {
        role: 'user',
        content:
          'Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. After you have worked it out, call acceptance_probe exactly once, wait for its result, then give a concise final answer.',
      },
    ];
    const first = await provider.chat(initial, {
      model,
      maxTokens: 1024,
      effort: 'max',
      tools,
      toolChoice: 'auto',
    });
    expect(first.tool_calls?.[0]?.function.name).toBe('acceptance_probe');
    expect(first.providerMetadata?.anthropicThinkingBlocks).toBeDefined();
    const continuation: ChatMessage[] = [
      ...initial,
      {
        role: 'assistant',
        content: first.content,
        tool_calls: first.tool_calls,
        providerMetadata: first.providerMetadata,
      },
      { role: 'tool', content: 'accepted', tool_call_id: first.tool_calls![0].id },
    ];
    const same = await provider.chat(continuation, {
      model,
      maxTokens: 256,
      tools,
      toolChoice: 'auto',
    });
    expect(same.usage?.total_tokens).toBeGreaterThan(0);
    expect(same.diagnostics?.reasoningContextReset).toBeUndefined();
    const edited = await provider.chat(
      [
        { role: 'system', content: 'New instruction after signed thinking was produced.' },
        ...continuation,
      ],
      { model, maxTokens: 256, tools, toolChoice: 'auto' },
    );
    expect(edited.diagnostics?.reasoningContextReset?.droppedBlocks).toBeGreaterThan(0);
    expect(
      edited.diagnostics?.reasoningContextReset?.reasons.prefix_binding_mismatch,
    ).toBeGreaterThan(0);
  }, 240_000);

  it('Opus 5.5 and Fable 5.1 preserve compatible thinking and report an incompatible model switch', async () => {
    const seed = async (model: 'claude-opus-5-5' | 'claude-fable-5-1') => {
      const question: ChatMessage = {
        role: 'user',
        content:
          'Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. Give only n.',
      };
      const first = await provider.chat([question], { model, maxTokens: 1024, effort: 'max' });
      expect(first.providerMetadata?.anthropicThinkingBlocks?.length).toBeGreaterThan(0);
      return [
        question,
        {
          role: 'assistant' as const,
          content: first.content,
          providerMetadata: first.providerMetadata,
        },
        { role: 'user' as const, content: 'Confirm the result briefly.' },
      ];
    };

    const opusHistory = await seed('claude-opus-5-5');
    const compatible = await provider.chat(opusHistory, {
      model: 'claude-fable-5-1',
      maxTokens: 128,
      effort: 'low',
    });
    expect(compatible.usage?.total_tokens).toBeGreaterThan(0);
    expect(compatible.diagnostics?.reasoningContextReset).toBeUndefined();

    const fableHistory = await seed('claude-fable-5-1');
    const incompatible = await provider.chat(fableHistory, {
      model: 'claude-opus-5-5',
      maxTokens: 128,
      effort: 'low',
    });
    expect(incompatible.usage?.total_tokens).toBeGreaterThan(0);
    expect(
      incompatible.diagnostics?.reasoningContextReset?.reasons.model_binding_mismatch,
    ).toBeGreaterThan(0);
  }, 240_000);

  it('Opus 5.5 reports edited tool and message prefixes, native error policy, and streamed reset', async () => {
    const model = 'claude-opus-5-5';
    const signal = AbortSignal.timeout(240_000);
    boundedFetch();
    const initial: ChatMessage[] = [
      {
        role: 'user',
        content:
          'Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. Then call acceptance_probe exactly once and wait for its result.',
      },
    ];
    const first = await provider.chat(initial, {
      model,
      maxTokens: 1024,
      effort: 'max',
      tools,
      toolChoice: 'auto',
      signal,
    });
    expect(first.providerMetadata?.anthropicThinkingBlocks?.length).toBeGreaterThan(0);
    expect(first.tool_calls?.[0]?.function.name).toBe('acceptance_probe');
    const continuation: ChatMessage[] = [
      ...initial,
      {
        role: 'assistant',
        content: first.content,
        tool_calls: first.tool_calls,
        providerMetadata: first.providerMetadata,
      },
      { role: 'tool', content: 'accepted', tool_call_id: first.tool_calls![0].id },
    ];

    const changedTools: ToolDefinition[] = [
      {
        ...tools[0],
        function: { ...tools[0].function, description: 'Changed tool definition after signing.' },
      },
    ];
    const toolEdit = await provider.chat(continuation, {
      model,
      maxTokens: 256,
      tools: changedTools,
      signal,
    });
    expect(
      toolEdit.diagnostics?.reasoningContextReset?.reasons.prefix_binding_mismatch,
    ).toBeGreaterThan(0);

    const messageEdit = await provider.chat(
      [
        { role: 'user', content: `${initial[0].content} An earlier detail changed.` },
        ...continuation.slice(1),
      ],
      { model, maxTokens: 256, tools, signal },
    );
    expect(
      messageEdit.diagnostics?.reasoningContextReset?.reasons.prefix_binding_mismatch,
    ).toBeGreaterThan(0);

    let nativeError: unknown;
    try {
      await provider.chat([{ role: 'system', content: 'New system prefix.' }, ...continuation], {
        model,
        maxTokens: 256,
        tools,
        signal,
        providerOptions: {
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
        },
      });
    } catch (error) {
      nativeError = error;
    }
    expect((nativeError as { name?: string })?.name).toBe('ProviderError');
    expect((nativeError as { status?: number })?.status).toBe(400);
    expect(
      (nativeError as { message?: string })?.message?.includes(
        'The block is bound to a different conversation',
      ),
    ).toBe(true);

    const done = await collectDone(
      provider.stream([{ role: 'system', content: 'New system prefix.' }, ...continuation], {
        model,
        maxTokens: 256,
        tools,
        signal,
      }),
    );
    expect(
      done.diagnostics?.reasoningContextReset?.reasons.prefix_binding_mismatch,
    ).toBeGreaterThan(0);
  }, 300_000);

  it('Opus 5.5 accepts a compacted tool tail without stale signed thinking', async () => {
    const model = 'claude-opus-5-5';
    const signal = AbortSignal.timeout(240_000);
    const requests: Array<Record<string, unknown>> = [];
    boundedFetch((body) => requests.push(body));
    const older: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Earlier exchange ${index}: ${'x'.repeat(200)}`,
    }));
    const questions: ChatMessage[] = [
      {
        role: 'user',
        content:
          'Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. After you have worked it out, call acceptance_probe exactly once, wait for its result, then give a concise final answer.',
      },
      {
        role: 'user',
        content:
          'Solve the simultaneous congruences n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. Prove uniqueness for 1 <= n <= 1001, then compute n squared mod 17. Work through the derivation before calling acceptance_probe exactly once; wait for its result before your final answer.',
      },
    ];
    let selected: { question: ChatMessage; seed: ProviderResponse } | undefined;
    const seedCosts: Array<number | undefined> = [];
    for (const question of questions) {
      const seed = await provider.chat([...older, question], {
        model,
        maxTokens: 1024,
        effort: 'max',
        tools,
        toolChoice: 'auto',
        signal,
      });
      seedCosts.push(seed.cost);
      if (
        seed.providerMetadata?.anthropicThinkingBlocks?.length &&
        seed.tool_calls?.length === 1 &&
        seed.tool_calls[0].function.name === 'acceptance_probe'
      ) {
        selected = { question, seed };
        break;
      }
    }
    if (!selected) throw new Error('Opus did not produce a signed single-tool seed');
    const { question, seed } = selected;
    const questionText = typeof question.content === 'string' ? question.content : '';
    expect(questionText).not.toBe('');
    const toolId = seed.tool_calls![0].id;

    const registry = new ProviderRegistry();
    registry.registerInstance('anthropic', provider);
    const events: AxlEvent[] = [];
    const acceptanceTool = tool({
      name: 'acceptance_probe',
      description: 'Return the fixed acceptance-test value.',
      input: z.object({}),
      handler: () => 'accepted',
    });
    const context = new WorkflowContext({
      input: 'task',
      executionId: 'opus-55-live-summary',
      metadata: {},
      config: { defaultProvider: 'anthropic', diagnostics: { silent: true } },
      providerRegistry: registry,
      signal,
      sessionHistory: [
        ...older,
        question,
        {
          role: 'assistant',
          content: seed.content,
          tool_calls: seed.tool_calls,
          providerMetadata: seed.providerMetadata,
        },
        { role: 'tool', content: 'accepted', tool_call_id: toolId },
      ],
      onTrace: (event) => events.push(event),
      _forceStreaming: true,
    });
    const worker = agent({
      name: 'opus-live-summary',
      model: `anthropic:${model}`,
      tools: [acceptanceTool],
      toolChoice: 'none',
      maxTurns: 1,
      maxTokens: 512,
      maxContext: 3400,
    });

    const seedEnd = requests.length;
    let firstEnd = 0;
    expect(String(await context.ask(worker, 'Confirm the result briefly.')).trim()).not.toBe('');
    firstEnd = requests.length;
    const eventsAfterFirst = events.length;
    expect(String(await context.ask(worker, 'Confirm it once more.')).trim()).not.toBe('');

    const callCosts = events
      .filter((event) => event.type === 'agent_call_end')
      .map((event) => event.cost);
    const costs = [...seedCosts, ...callCosts];
    console.info(
      `[frontier-summary] calls=${costs.length} knownCostUsd=${costs
        .reduce<number>((total, cost) => total + (typeof cost === 'number' ? cost : 0), 0)
        .toFixed(6)} unpricedCalls=${costs.filter((cost) => typeof cost !== 'number').length}`,
    );

    const isSummary = (body: Record<string, unknown>) =>
      String(body.system).includes('Summarize the following conversation');
    const firstRequests = requests.slice(seedEnd, firstEnd);
    const secondRequests = requests.slice(firstEnd);
    expect(firstRequests.some(isSummary)).toBe(true);
    // Reuse is conditional on the entire uncovered tail fitting. If a second
    // summary is needed, the raw question must remain in its input or tail.
    const secondSummary = secondRequests.find(isSummary);
    if (secondSummary) {
      expect(
        JSON.stringify(secondSummary.messages).includes(questionText) ||
          JSON.stringify(
            secondRequests.filter((body) => !isSummary(body)).at(-1)?.messages,
          ).includes(questionText),
      ).toBe(true);
    }
    const continuations = [
      firstRequests.filter((body) => !isSummary(body)).at(-1),
      secondRequests.filter((body) => !isSummary(body)).at(-1),
    ];
    for (const [index, body] of continuations.entries()) {
      expect(String(body?.system)).toContain('Summary of earlier conversation');
      // A second compaction may legitimately summarize the seed tool exchange.
      // The first compacted request is the provider acceptance check for its
      // retained text/tool-use/tool-result without stale signed thinking.
      if (index === 1 && secondSummary) continue;
      const messages = body?.messages as Array<{
        role: string;
        content: string | Array<{ type: string; text?: string; id?: string; tool_use_id?: string }>;
      }>;
      expect(
        messages.some(
          (message) =>
            message.role === 'user' && JSON.stringify(message.content).includes(questionText),
        ),
      ).toBe(true);
      const assistant = messages.find(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'tool_use' && block.id === toolId),
      );
      const assistantBlocks = Array.isArray(assistant?.content) ? assistant.content : [];
      // The seed's thinking was signed before Axl inserted the summary. It
      // must not be re-sent, while its text/tool-use and the tool result stay.
      expect(assistantBlocks.some((block) => block.type === 'thinking')).toBe(false);
      if (seed.content) {
        expect(
          assistantBlocks.some((block) => block.type === 'text' && block.text === seed.content),
        ).toBe(true);
      }
      expect(
        messages.some(
          (message) =>
            message.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some(
              (block) => block.type === 'tool_result' && block.tool_use_id === toolId,
            ),
        ),
      ).toBe(true);
    }
    expect(
      events.filter((event) => event.type === 'agent_call_end' && event.data.purpose === 'summary'),
    ).toHaveLength(
      firstRequests.filter(isSummary).length + secondRequests.filter(isSummary).length,
    );
    const firstResets = events
      .slice(0, eventsAfterFirst)
      .flatMap((event) =>
        event.type === 'provider_diagnostic' && event.data.kind === 'reasoning_context_reset'
          ? [event.data]
          : [],
      );
    // Axl reports its own removal of the seed's stale thinking once, before
    // the first compacted call; Anthropic itself reports no reset.
    const seedThinking = (seed.providerMetadata?.anthropicThinkingBlocks as unknown[]).filter(
      (block) =>
        ['thinking', 'redacted_thinking'].includes(String((block as { type?: unknown }).type)),
    ).length;
    expect(firstResets.map((reset) => [reset.droppedBlocks, reset.reasons])).toEqual([
      [seedThinking, { client_prefix_rewrite: seedThinking }],
    ]);
  }, 300_000);

  // Owner remediation row: a second execution on the same session reuses the
  // persisted per-agent ask-summary boundary, so the projected prefix is
  // identical and thinking produced after the boundary stays valid.
  it('Opus 5.5 reuses a persisted ask-summary boundary across executions with kept thinking', async () => {
    const model = 'claude-opus-5-5';
    const signal = AbortSignal.timeout(240_000);
    const requests: Array<Record<string, unknown>> = [];
    boundedFetch((body) => requests.push(body));
    const isSummary = (body: Record<string, unknown>) =>
      String(body.system).includes('Summarize the following conversation');

    const runtime = new AxlRuntime({ defaultProvider: 'anthropic', diagnostics: { silent: true } });
    runtime.registerProvider('anthropic', provider);
    const store = runtime.getStateStore();
    const sessionId = 'opus-55-live-boundary';
    await store.saveSession(
      sessionId,
      Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `Earlier exchange ${index}: ${'x'.repeat(200)}`,
      })),
    );
    const events: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => events.push(event));
    const worker = agent({
      name: 'opus-live-boundary',
      model: `anthropic:${model}`,
      effort: 'max',
      maxTurns: 1,
      maxTokens: 768,
      maxContext: 3400,
    });
    runtime.register(
      workflow({ name: 'chat', input: z.string(), handler: (ctx) => ctx.ask(worker, ctx.input) }),
    );
    const session = runtime.session(sessionId);

    await session.send(
      'chat',
      'Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, and n mod 13 = 8. Work it through carefully, then answer with just the number.',
      { signal },
    );
    const firstEnd = requests.length;
    const eventsAfterFirst = events.length;
    const firstRequests = requests.slice(0, firstEnd);
    expect(firstRequests.some(isSummary)).toBe(true);

    const history = await store.getSession(sessionId);
    const reply = history.at(-1);
    expect(reply?.role).toBe('assistant');
    const kept = ((reply?.providerMetadata?.anthropicThinkingBlocks as unknown[]) ?? []).filter(
      (block) => (block as { type?: unknown }).type === 'thinking',
    ) as Array<{ signature?: string }>;
    if (kept.length === 0) {
      throw new Error(
        'Opus produced no signed thinking on the compacted first execution; the reuse row cannot be proven by this run',
      );
    }

    await session.send('chat', 'Now give n squared mod 17. Answer with just the number.', {
      signal,
    });
    const secondRequests = requests.slice(firstEnd);
    const callCosts = events
      .filter((event) => event.type === 'agent_call_end')
      .map((event) => event.cost);
    console.info(
      `[frontier-boundary] calls=${callCosts.length} knownCostUsd=${callCosts
        .reduce<number>((total, cost) => total + (typeof cost === 'number' ? cost : 0), 0)
        .toFixed(6)} unpricedCalls=${callCosts.filter((cost) => typeof cost !== 'number').length}`,
    );

    // Reuse: no second summary call, one model call, same summary prefix.
    expect(secondRequests.filter(isSummary)).toEqual([]);
    expect(secondRequests).toHaveLength(1);
    const body = secondRequests[0];
    expect(String(body.system)).toContain('Summary of earlier conversation');
    expect(String(body.system)).toBe(
      String(firstRequests.filter((request) => !isSummary(request)).at(-1)?.system),
    );
    // The kept post-boundary thinking is replayed under drop_block ...
    const messages = body.messages as Array<{
      role: string;
      content: string | Array<{ type: string; signature?: string }>;
    }>;
    expect(
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'thinking' && block.signature === kept[0].signature,
          ),
      ),
    ).toBe(true);
    expect((body.thinking as { block_binding?: unknown }).block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    });
    // ... and neither Axl nor Anthropic reports a reset on the second execution.
    const secondResets = events
      .slice(eventsAfterFirst)
      .filter(
        (event) =>
          event.type === 'provider_diagnostic' && event.data.kind === 'reasoning_context_reset',
      );
    expect(secondResets).toEqual([]);
    expect(
      events
        .slice(eventsAfterFirst)
        .filter((event) => event.type === 'agent_call_end' && event.data.purpose === 'summary'),
    ).toEqual([]);
  }, 300_000);

  it.each(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'])(
    'non-stream accepts exact model %s with its default thinking mode',
    async (model) => {
      expectMetered(await provider.chat(prompt, { model, maxTokens: 128 }), 'static');
    },
    120_000,
  );

  it('stream returns terminal metered usage for claude-sonnet-5', async () => {
    const done = await collectDone(
      provider.stream(prompt, { model: 'claude-sonnet-5', maxTokens: 128 }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 120_000);

  it('tool continuation replays Claude 5 provider metadata', async () => {
    await toolContinuation(provider, 'claude-sonnet-5', 'static');
  }, 180_000);
});

describe.skipIf(!process.env.GOOGLE_API_KEY)('latest models: Gemini live acceptance', () => {
  let provider: GeminiProvider;
  beforeAll(() => {
    provider = new GeminiProvider();
  });

  it.each(['gemini-3.6-flash', 'gemini-3.5-flash-lite'])(
    'non-stream accepts exact model %s without deprecated sampling fields',
    async (model) => {
      expectMetered(
        await provider.chat(prompt, { model, maxTokens: 256, temperature: 0.7 }),
        'static',
      );
    },
    60_000,
  );

  it('stream returns terminal metered usage for gemini-3.5-flash-lite', async () => {
    const done = await collectDone(
      provider.stream(prompt, { model: 'gemini-3.5-flash-lite', maxTokens: 256 }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThan(0);
  }, 60_000);

  it('tool continuation preserves Gemini 3.5 function identity metadata', async () => {
    await toolContinuation(provider, 'gemini-3.5-flash-lite', 'static');
  }, 120_000);
});

describe.skipIf(!process.env.XAI_API_KEY)('latest models: xAI Chat live acceptance', () => {
  let provider: OpenAICompatibleProvider;
  beforeAll(() => {
    provider = new OpenAICompatibleProvider({ profile: XAI_PROFILE });
  });

  it.each(['grok-4.5', 'grok-4.3', 'grok-4.20', 'grok-4.20-non-reasoning'])(
    'non-stream accepts exact current Chat model %s and returned USD ticks',
    async (model) => {
      expectMetered(await provider.chat(prompt, { model, maxTokens: 32 }), 'reported');
    },
    60_000,
  );

  it('stream reads terminal USD ticks for grok-4.20', async () => {
    const done = await collectDone(provider.stream(prompt, { model: 'grok-4.20', maxTokens: 32 }));
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('client function-tool continuation succeeds on grok-4.20', async () => {
    await toolContinuation(provider, 'grok-4.20', 'reported');
  }, 120_000);
});
