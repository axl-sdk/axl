import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { OpenAIProvider } from '../providers/openai.js';
import { XAI_PROFILE } from '../providers/profiles/xai.js';
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
  const chat = new OpenAIProvider();
  const responses = new OpenAIResponsesProvider();

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
  const provider = new AnthropicProvider();

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
      { role: 'user', content: 'Call acceptance_probe now. Do not answer directly.' },
    ];
    const first = await provider.chat(initial, {
      model,
      maxTokens: 512,
      effort: 'high',
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
  const provider = new GeminiProvider();

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
  const provider = new OpenAICompatibleProvider({ profile: XAI_PROFILE });

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
