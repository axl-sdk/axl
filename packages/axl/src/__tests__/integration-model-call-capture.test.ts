/**
 * P1 live checklist preparation (L1-L4). These provider-gated calls are not
 * part of the offline test gate. Keep payloads tiny; the owner authorizes spend
 * before running this file through the integration config.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import type { Provider, StreamChunk } from '../providers/types.js';

const prompt = [{ role: 'user' as const, content: 'Reply with the single word: pong' }];
const geminiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;

async function streamDone(provider: Provider, model: string) {
  let done: Extract<StreamChunk, { type: 'done' }> | undefined;
  for await (const chunk of provider.stream(prompt, { model, maxTokens: 32 })) {
    if (chunk.type === 'done') done = chunk;
  }
  expect(done).toBeDefined();
  return done!;
}

function expectIdentity(value: { responseId?: string; responseModel?: string }) {
  expect(value.responseId).toMatch(/\S/);
  expect(value.responseModel).toMatch(/\S/);
}

for (const c of [
  {
    name: 'OpenAI Chat',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: () => new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  },
  {
    name: 'OpenAI Responses',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: () => new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  },
] satisfies Array<{ name: string; key?: string; model: string; make: () => Provider }>) {
  describe.skipIf(!c.key)(`model-call metadata live — ${c.name}`, () => {
    it('L1/L2: chat and stream report a normal finish and wire identity', async () => {
      const provider = c.make();
      const chat = await provider.chat(prompt, { model: c.model, maxTokens: 32 });
      expect(chat.finishReason).toBe('stop');
      expect(chat.rawFinishReason).toMatch(/\S/);
      expectIdentity(chat);

      const done = await streamDone(provider, c.model);
      expect(done.finishReason).toBe('stop');
      expect(done.rawFinishReason).toMatch(/\S/);
      expectIdentity(done);
    });
  });
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('model-call metadata live — Anthropic', () => {
  it('L3: max_tokens truncation reports length and the raw reason', async () => {
    const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const response = await provider.chat(
      [{ role: 'user', content: 'Write a complete paragraph about rivers.' }],
      { model: 'claude-haiku-4-5', maxTokens: 1 },
    );
    expect(response.finishReason).toBe('length');
    expect(response.rawFinishReason).toBe('max_tokens');
    expectIdentity(response);
  });
});

describe.skipIf(!geminiKey)('model-call metadata live — Gemini', () => {
  it('L4: a forced function call reports tool_calls and the raw STOP reason', async () => {
    const provider = new GeminiProvider({ apiKey: geminiKey! });
    const response = await provider.chat(
      [{ role: 'user', content: 'Find the weather in Boston.' }],
      {
        model: 'gemini-3.5-flash-lite',
        maxTokens: 64,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Look up weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        toolChoice: 'required',
      },
    );
    expect(response.tool_calls?.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe('tool_calls');
    expect(response.rawFinishReason).toBe('STOP');
    expectIdentity(response);
  });
});
