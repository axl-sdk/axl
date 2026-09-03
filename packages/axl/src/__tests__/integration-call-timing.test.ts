/**
 * Live verification for the per-call `CallTiming` block (plan: provider-call-timing §8).
 * Exercises the four built-in chat adapters directly at the transport boundary with
 * the cheapest supported models and tiny payloads. Gated on API keys; the routine
 * `pnpm test:integration` gate.
 *
 * What a mock cannot establish and this does:
 *  - L1: a real non-streaming response reports timing with a single attempt, no queue,
 *    and headers that arrive only once generation is done (ttfb dominates wire).
 *  - L2: a real stream reports first-token time strictly between headers and last byte.
 *  - L3: a real governor under fan-out shows queue wait on the calls it parked.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { Provider, StreamChunk, ChatMessage } from '../providers/types.js';
import type { CallTiming } from '../types.js';

type Case = {
  name: string;
  key: string | undefined;
  model: string;
  make: (rateLimit?: { maxConcurrent: number }) => Provider;
};

const cases: Case[] = [
  {
    name: 'openai',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: (rateLimit) => new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, rateLimit }),
  },
  {
    name: 'openai-responses',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-nano',
    make: (rateLimit) =>
      new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY!, rateLimit }),
  },
  {
    name: 'anthropic',
    key: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5',
    make: (rateLimit) =>
      new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, rateLimit }),
  },
  {
    name: 'gemini',
    key: process.env.GOOGLE_API_KEY,
    model: 'gemini-3.5-flash-lite',
    make: (rateLimit) => new GeminiProvider({ apiKey: process.env.GOOGLE_API_KEY!, rateLimit }),
  },
];

const shortPrompt: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: pong' }];
const longPrompt: ChatMessage[] = [
  {
    role: 'user',
    content:
      'Write a plain-prose paragraph of about 150 words describing how rivers form deltas. No lists.',
  },
];

function assertDomain(t: CallTiming): void {
  for (const [k, v] of Object.entries(t)) {
    expect(Number.isInteger(v), `${k} must be an integer`).toBe(true);
    expect(v, `${k} must be >= 0`).toBeGreaterThanOrEqual(0);
  }
  expect(t.attempts).toBeGreaterThanOrEqual(1);
  expect(t.wireMs).toBeGreaterThanOrEqual(t.ttfbMs);
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<{
  text: string;
  done: Extract<StreamChunk, { type: 'done' }> | undefined;
}> {
  let text = '';
  let done: Extract<StreamChunk, { type: 'done' }> | undefined;
  for await (const chunk of gen) {
    if (chunk.type === 'text_delta') text += chunk.content;
    if (chunk.type === 'done') done = chunk;
  }
  return { text, done };
}

for (const c of cases) {
  describe.skipIf(!c.key)(`CallTiming live — ${c.name}`, () => {
    it('L1: chat() reports single-attempt timing where headers wait for generation', async () => {
      const res = await c.make().chat(shortPrompt, { model: c.model, maxTokens: 16 });
      expect(res.timing, 'chat() must return timing').toBeDefined();
      const t = res.timing!;
      console.log(`[timing:${c.name}] chat`, JSON.stringify(t));
      assertDomain(t);
      expect(t.attempts).toBe(1);
      expect(t.retryMs).toBe(0);
      expect(t.queuedMs).toBe(0);
      expect(t.firstTokenMs).toBeUndefined();
      expect(t.ttfbMs).toBeGreaterThan(0);
      // Non-streaming: the provider sends headers only once the answer is generated,
      // so the body transfer after headers is a small fraction of time-to-headers.
      expect(t.wireMs - t.ttfbMs).toBeLessThan(Math.max(250, t.ttfbMs));
    }, 60_000);

    it('L2: stream() reports first-token time strictly inside headers..last-byte', async () => {
      const { text, done } = await drain(
        c.make().stream(longPrompt, { model: c.model, maxTokens: 400 }),
      );
      expect(text.length).toBeGreaterThan(200);
      expect(done?.timing, 'done chunk must carry timing').toBeDefined();
      const t = done!.timing!;
      console.log(`[timing:${c.name}] stream`, JSON.stringify(t), `chars=${text.length}`);
      assertDomain(t);
      expect(t.attempts).toBe(1);
      expect(t.queuedMs).toBe(0);
      expect(t.firstTokenMs).toBeDefined();
      expect(t.firstTokenMs!).toBeGreaterThanOrEqual(t.ttfbMs);
      expect(t.wireMs).toBeGreaterThan(t.firstTokenMs!);
      // A ~150-word generation takes real time after the first token.
      expect(t.wireMs - t.firstTokenMs!).toBeGreaterThan(50);
    }, 60_000);
  });
}

const governed = cases[0]!;
describe.skipIf(!governed.key)('CallTiming live — governed fan-out (L3)', () => {
  it('maxConcurrent: 1 with 3 parallel chat() calls parks two of them', async () => {
    const provider = governed.make({ maxConcurrent: 1 });
    const started = Date.now();
    const results = await Promise.all(
      [0, 1, 2].map(() => provider.chat(shortPrompt, { model: governed.model, maxTokens: 16 })),
    );
    const wall = Date.now() - started;
    const timings = results.map((r) => r.timing!);
    console.log(`[timing:${governed.name}] governed`, JSON.stringify(timings), `wall=${wall}`);
    for (const t of timings) {
      expect(t).toBeDefined();
      assertDomain(t);
      expect(t.queuedMs).toBeLessThanOrEqual(wall);
    }
    const parked = timings.filter((t) => t.queuedMs > 100).length;
    const immediate = timings.filter((t) => t.queuedMs < 50).length;
    expect(parked, 'at least two calls waited on the permit').toBeGreaterThanOrEqual(2);
    expect(immediate, 'at least one call was granted immediately').toBeGreaterThanOrEqual(1);
    // The parked calls' queue wait is roughly the earlier calls' wire time, not more.
    const maxQueued = Math.max(...timings.map((t) => t.queuedMs));
    const sumWire = timings.reduce((s, t) => s + t.wireMs, 0);
    expect(maxQueued).toBeLessThanOrEqual(sumWire + 100);
  }, 90_000);
});
