import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIProvider, OPENAI_PROFILE } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { AxlEvent, ModelInput } from '../types.js';

/**
 * Live certification for Spec 23. Mocked transports prove deterministic timer
 * behavior; these rows prove the built-in adapters actually forward the
 * runtime's composed signal to their real streaming transports.
 */
type LiveCase = {
  name: string;
  key: string | undefined;
  model: string;
  make: () => Provider;
  prompt?: ModelInput;
  maxTokens?: number;
  effort?: 'minimal';
};

const textPrompt =
  'In about 40 words, explain why leaves look green. Use plain prose with no list.';
const onePixelPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=',
    'base64',
  ),
);

const cases: LiveCase[] = [
  {
    name: 'openai-chat',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: () => new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  },
  {
    name: 'openai-responses',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-5-nano',
    make: () => new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY! }),
    // This reasoning model can consume a 128-token budget before emitting any
    // output text; 512 remains a tiny live probe and reliably reaches a token.
    maxTokens: 512,
    effort: 'minimal',
    prompt: 'Reply with exactly the single word: green',
  },
  {
    name: 'anthropic',
    key: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5',
    make: () => new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  },
  {
    name: 'google-generate-content',
    key: process.env.GOOGLE_API_KEY,
    model: 'gemini-3.5-flash-lite',
    make: () => new GeminiProvider({ apiKey: process.env.GOOGLE_API_KEY! }),
  },
  {
    name: 'google-interactions',
    key: process.env.GOOGLE_API_KEY,
    model: 'gemini-3.8-flash',
    make: () => new GeminiProvider({ apiKey: process.env.GOOGLE_API_KEY! }),
    prompt: [
      { type: 'text', text: 'Describe the color in this one-pixel image in one short sentence.' },
      {
        type: 'image',
        source: { type: 'bytes', data: onePixelPng, mediaType: 'image/png' },
      },
    ],
  },
  {
    name: 'openai-compatible-profile',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: () =>
      new OpenAICompatibleProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        profile: {
          ...OPENAI_PROFILE,
          name: 'openai-compatible-live',
          label: 'OpenAI-compatible live profile',
        },
      }),
  },
];

function liveContext(provider: Provider, onTrace: (event: AxlEvent) => void): WorkflowContext {
  const registry = new ProviderRegistry();
  registry.registerInstance(provider.name, provider);
  const ctx = new WorkflowContext({
    input: 'live timeout verification',
    executionId: `timeout-live-${randomUUID()}`,
    config: {},
    providerRegistry: registry,
    onTrace,
  });
  void ctx.events;
  return ctx;
}

for (const live of cases) {
  describe.skipIf(!live.key)(`timeout/deadline live — ${live.name}`, () => {
    it('propagates exact in-flight abort and emits no post-abort continuation', async () => {
      const controller = new AbortController();
      const reason = new Error(`live abort sentinel: ${live.name}`);
      let tokens = 0;
      let tokensAtAbort = 0;
      const provider = live.make();
      const ctx = liveContext(provider, (event) => {
        if (event.type !== 'token') return;
        tokens++;
        if (!controller.signal.aborted) {
          tokensAtAbort = tokens;
          controller.abort(reason);
        }
      });
      const liveAgent = agent({
        name: `timeout-live-${live.name}`,
        model: `${provider.name}:${live.model}`,
        system: 'Answer directly and briefly.',
      });

      await expect(
        ctx.ask(liveAgent, live.prompt ?? textPrompt, {
          maxTokens: live.maxTokens ?? 128,
          effort: live.effort,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(tokensAtAbort).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(tokens).toBe(tokensAtAbort);
    }, 60_000);

    it('completes a real progressing stream under a conservative stall window', async () => {
      let tokens = 0;
      const provider = live.make();
      const ctx = liveContext(provider, (event) => {
        if (event.type === 'token') tokens++;
      });
      const liveAgent = agent({
        name: `stall-live-${live.name}`,
        model: `${provider.name}:${live.model}`,
        system: 'Answer directly and briefly.',
      });
      const result = await ctx.ask(liveAgent, live.prompt ?? textPrompt, {
        maxTokens: live.maxTokens ?? 128,
        effort: live.effort,
        stallTimeout: '20s',
        signal: AbortSignal.timeout(60_000),
      });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
      expect(tokens).toBeGreaterThan(0);
    }, 75_000);
  });
}
