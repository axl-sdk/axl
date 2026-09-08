/**
 * Phase 0 baselines for the general-audio-input workstream.
 *
 * This suite asserts that each adapter still sends the frozen bodies in
 * `fixtures/rich-input-baselines.ts`, and still throws the frozen
 * `{modality, feature, source}` triples for image-only rejections. Later
 * phases of the audio work compare against the same fixtures with
 * `toEqual`/`toMatchObject` (NOT vitest snapshots) to prove text-only and
 * image-only request bodies stay byte-identical before and after the audio
 * change lands — they import the fixture module, never this test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import {
  ANTHROPIC_IMAGE_BODY,
  ANTHROPIC_STRING_BODY,
  GOOGLE_IMAGE_BODY,
  GOOGLE_STRING_BODY,
  IMAGE_INPUT,
  IMAGE_REJECTION_TRIPLES,
  OPENAI_RESPONSES_IMAGE_BODY,
  OPENAI_RESPONSES_STRING_BODY,
  OPENAI_STRING_BODY,
  OPENROUTER_IMAGE_BODY,
  OPENROUTER_STRING_BODY,
  STRING_INPUT,
} from './fixtures/rich-input-baselines.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function providerFileImage(provider: string) {
  return [
    {
      type: 'image' as const,
      source: {
        type: 'provider-file' as const,
        provider,
        reference: 'ref-1',
        mediaType: 'image/png',
      },
    },
  ];
}

describe('Phase 0 rich-input baselines', () => {
  describe('string-only request bodies', () => {
    it('OpenAI chat completions', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'Sunny.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('openai', new OpenAIProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'openai-string',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'openai:gpt-4o' }), STRING_INPUT),
        }),
      );
      await expect(runtime.execute('openai-string', {})).resolves.toBe('Sunny.');
      expect(requestBody(fetch)).toEqual(OPENAI_STRING_BODY);
      await runtime.shutdown();
    });

    it('OpenRouter (OpenAI-compatible)', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'Sunny.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openrouter',
        new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openrouter-string',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(
              agent({
                model: 'openrouter:catalog/default',
                providerOptions: { model: 'vendor/text' },
              }),
              STRING_INPUT,
            ),
        }),
      );
      await expect(runtime.execute('openrouter-string', {})).resolves.toBe('Sunny.');
      expect(requestBody(fetch)).toEqual(OPENROUTER_STRING_BODY);
      await runtime.shutdown();
    });

    it('Google Gemini', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'Sunny.' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('google', new GeminiProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'google-string',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), STRING_INPUT),
        }),
      );
      await expect(runtime.execute('google-string', {})).resolves.toBe('Sunny.');
      expect(requestBody(fetch)).toEqual(GOOGLE_STRING_BODY);
      await runtime.shutdown();
    });

    it('Anthropic', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Sunny.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'anthropic-string',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'anthropic:claude-sonnet-4' }), STRING_INPUT),
        }),
      );
      await expect(runtime.execute('anthropic-string', {})).resolves.toBe('Sunny.');
      expect(requestBody(fetch)).toEqual(ANTHROPIC_STRING_BODY);
      await runtime.shutdown();
    });

    it('OpenAI Responses', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'resp_1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Sunny.' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openai-responses',
        new OpenAIResponsesProvider({ apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openai-responses-string',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'openai-responses:gpt-4o' }), STRING_INPUT),
        }),
      );
      await expect(runtime.execute('openai-responses-string', {})).resolves.toBe('Sunny.');
      expect(requestBody(fetch)).toEqual(OPENAI_RESPONSES_STRING_BODY);
      await runtime.shutdown();
    });
  });

  describe('image-only request bodies', () => {
    it('OpenRouter (OpenAI-compatible)', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'A pixel.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openrouter',
        new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openrouter-image',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(
              agent({
                model: 'openrouter:catalog/default',
                providerOptions: { model: 'vendor/vision' },
              }),
              IMAGE_INPUT,
            ),
        }),
      );
      await expect(runtime.execute('openrouter-image', {})).resolves.toBe('A pixel.');
      expect(requestBody(fetch)).toEqual(OPENROUTER_IMAGE_BODY);
      await runtime.shutdown();
    });

    it('Google Gemini (Interactions endpoint)', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A pixel.' }] }],
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('google', new GeminiProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'google-image',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), IMAGE_INPUT),
        }),
      );
      await expect(runtime.execute('google-image', {})).resolves.toBe('A pixel.');
      expect(requestBody(fetch)).toEqual(GOOGLE_IMAGE_BODY);
      await runtime.shutdown();
    });

    it('Anthropic', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'A pixel.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'anthropic-image',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'anthropic:claude-sonnet-4' }), IMAGE_INPUT),
        }),
      );
      await expect(runtime.execute('anthropic-image', {})).resolves.toBe('A pixel.');
      expect(requestBody(fetch)).toEqual(ANTHROPIC_IMAGE_BODY);
      await runtime.shutdown();
    });

    it('OpenAI Responses', async () => {
      const fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'resp_1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'A pixel.' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openai-responses',
        new OpenAIResponsesProvider({ apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openai-responses-image',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'openai-responses:gpt-4o' }), IMAGE_INPUT),
        }),
      );
      await expect(runtime.execute('openai-responses-image', {})).resolves.toBe('A pixel.');
      expect(requestBody(fetch)).toEqual(OPENAI_RESPONSES_IMAGE_BODY);
      await runtime.shutdown();
    });
  });

  describe('image rejection triples', () => {
    it('OpenAI chat completions rejects any image', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('openai', new OpenAIProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'openai-image-reject',
          input: z.object({}),
          handler: (ctx) => ctx.ask(agent({ model: 'openai:gpt-4o' }), IMAGE_INPUT),
        }),
      );
      await expect(runtime.execute('openai-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.openai.modality,
        source: IMAGE_REJECTION_TRIPLES.openai.source,
        message: IMAGE_REJECTION_TRIPLES.openai.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });

    it('OpenAI Responses rejects a mismatched provider-file', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openai-responses',
        new OpenAIResponsesProvider({ apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openai-responses-image-reject',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(agent({ model: 'openai-responses:gpt-4o' }), providerFileImage('google')),
        }),
      );
      await expect(runtime.execute('openai-responses-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.openaiResponsesMismatchedProviderFile.modality,
        source: IMAGE_REJECTION_TRIPLES.openaiResponsesMismatchedProviderFile.source,
        message: IMAGE_REJECTION_TRIPLES.openaiResponsesMismatchedProviderFile.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });

    it('Google Gemini rejects a raw URL source', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('google', new GeminiProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'google-image-reject',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
              { type: 'image', source: { type: 'url', url: 'https://example.com/pixel.png' } },
            ]),
        }),
      );
      await expect(runtime.execute('google-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.googleUrlSource.modality,
        source: IMAGE_REJECTION_TRIPLES.googleUrlSource.source,
        message: IMAGE_REJECTION_TRIPLES.googleUrlSource.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });

    it('OpenRouter rejects a provider-file source', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider(
        'openrouter',
        new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
      );
      runtime.register(
        workflow({
          name: 'openrouter-image-reject',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(
              agent({
                model: 'openrouter:catalog/default',
                providerOptions: { model: 'vendor/vision' },
              }),
              providerFileImage('google'),
            ),
        }),
      );
      await expect(runtime.execute('openrouter-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.openrouterMismatchedProviderFile.modality,
        source: IMAGE_REJECTION_TRIPLES.openrouterMismatchedProviderFile.source,
        message: IMAGE_REJECTION_TRIPLES.openrouterMismatchedProviderFile.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });

    it('Anthropic rejects a mismatched provider-file', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey: 'test-key' }));
      runtime.register(
        workflow({
          name: 'anthropic-image-reject',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(agent({ model: 'anthropic:claude-sonnet-4' }), providerFileImage('google')),
        }),
      );
      await expect(runtime.execute('anthropic-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.anthropicMismatchedProviderFile.modality,
        source: IMAGE_REJECTION_TRIPLES.anthropicMismatchedProviderFile.source,
        message: IMAGE_REJECTION_TRIPLES.anthropicMismatchedProviderFile.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });

    it('MockProvider rejects a mismatched provider-file', async () => {
      const fetch = vi.fn();
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = new AxlRuntime();
      runtime.registerProvider('mock', MockProvider.echo());
      runtime.register(
        workflow({
          name: 'mock-image-reject',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(agent({ model: 'mock:mock-model' }), providerFileImage('google')),
        }),
      );
      await expect(runtime.execute('mock-image-reject', {})).rejects.toMatchObject({
        modality: IMAGE_REJECTION_TRIPLES.mockMismatchedProviderFile.modality,
        source: IMAGE_REJECTION_TRIPLES.mockMismatchedProviderFile.source,
        message: IMAGE_REJECTION_TRIPLES.mockMismatchedProviderFile.message,
      });
      expect(fetch).not.toHaveBeenCalled();
      await runtime.shutdown();
    });
  });
});
