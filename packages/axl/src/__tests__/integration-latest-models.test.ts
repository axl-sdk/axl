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

function expectMetered(response: ProviderResponse): void {
  expect(response.content.trim().length).toBeGreaterThan(0);
  expect(response.usage?.total_tokens).toBeGreaterThan(0);
  expect(response.cost).toBeTypeOf('number');
  expect(response.cost).toBeGreaterThanOrEqual(0);
}

async function toolContinuation(provider: Provider, model: string): Promise<void> {
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
}

describe.skipIf(!process.env.OPENAI_API_KEY)('latest models: OpenAI live acceptance', () => {
  const chat = new OpenAIProvider();
  const responses = new OpenAIResponsesProvider();

  it.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'Chat non-stream accepts exact model %s',
    async (model) => {
      expectMetered(await chat.chat(prompt, { model, maxTokens: 32, effort: 'none' }));
    },
    60_000,
  );

  it('Responses non-stream accepts gpt-5.6-luna with native max', async () => {
    expectMetered(
      await responses.chat(prompt, { model: 'gpt-5.6-luna', maxTokens: 64, effort: 'max' }),
    );
  }, 60_000);

  it('Chat stream returns terminal metered usage for gpt-5.6-luna', async () => {
    const done = await collectDone(
      chat.stream(prompt, { model: 'gpt-5.6-luna', maxTokens: 32, effort: 'none' }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('Responses stream returns terminal metered usage for gpt-5.6-luna', async () => {
    const done = await collectDone(
      responses.stream(prompt, { model: 'gpt-5.6-luna', maxTokens: 32, effort: 'none' }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('Responses tool continuation succeeds on gpt-5.6-luna', async () => {
    await toolContinuation(responses, 'gpt-5.6-luna');
  }, 120_000);
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('latest models: Anthropic live acceptance', () => {
  const provider = new AnthropicProvider();

  it.each(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'])(
    'non-stream accepts exact model %s with its default thinking mode',
    async (model) => {
      expectMetered(await provider.chat(prompt, { model, maxTokens: 128 }));
    },
    120_000,
  );

  it('stream returns terminal metered usage for claude-sonnet-5', async () => {
    const done = await collectDone(
      provider.stream(prompt, { model: 'claude-sonnet-5', maxTokens: 128 }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('tool continuation replays Claude 5 provider metadata', async () => {
    await toolContinuation(provider, 'claude-sonnet-5');
  }, 180_000);
});

describe.skipIf(!process.env.GOOGLE_API_KEY)('latest models: Gemini live acceptance', () => {
  const provider = new GeminiProvider();

  it.each(['gemini-3.6-flash', 'gemini-3.5-flash-lite'])(
    'non-stream accepts exact model %s without deprecated sampling fields',
    async (model) => {
      expectMetered(await provider.chat(prompt, { model, maxTokens: 256, temperature: 0.7 }));
    },
    60_000,
  );

  it('stream returns terminal metered usage for gemini-3.5-flash-lite', async () => {
    const done = await collectDone(
      provider.stream(prompt, { model: 'gemini-3.5-flash-lite', maxTokens: 256 }),
    );
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('tool continuation preserves Gemini 3.5 function identity metadata', async () => {
    await toolContinuation(provider, 'gemini-3.5-flash-lite');
  }, 120_000);
});

describe.skipIf(!process.env.XAI_API_KEY)('latest models: xAI Chat live acceptance', () => {
  const provider = new OpenAICompatibleProvider({ profile: XAI_PROFILE });

  it.each(['grok-4.5', 'grok-4.3', 'grok-4.20', 'grok-4.20-non-reasoning'])(
    'non-stream accepts exact current Chat model %s and returned USD ticks',
    async (model) => {
      expectMetered(await provider.chat(prompt, { model, maxTokens: 32 }));
    },
    60_000,
  );

  it('stream reads terminal USD ticks for grok-4.20', async () => {
    const done = await collectDone(provider.stream(prompt, { model: 'grok-4.20', maxTokens: 32 }));
    expect(done.usage?.total_tokens).toBeGreaterThan(0);
    expect(done.cost).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('client function-tool continuation succeeds on grok-4.20', async () => {
    await toolContinuation(provider, 'grok-4.20');
  }, 120_000);
});
