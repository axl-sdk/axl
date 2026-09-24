/**
 * Live verification for adaptive rate governance (plan: adaptive-rate-governance §8).
 * Gated on API keys; part of the routine `pnpm test:integration` gate. The
 * newest cheap tier per vendor and tiny payloads, except L8's cached prefix,
 * which must clear the model's cache minimum to be a real cache read.
 *
 * What a mock cannot establish and this does:
 *  - L1/L2: real 2xx responses (non-stream and stream) carry the quota headers the
 *    OpenAI and Anthropic dialects read, and `hint` turns them into a ratio.
 *  - L4: which rate-limit headers Gemini actually sends (decides a Gemini dialect).
 *  - L8: on a first-party dialect scope with no `rateLimit`, image-heavy and
 *    cached-prompt calls add zero self-imposed wait before any 429 (the R1 guard).
 *  - L10: the same guard on a dialect-less scope (Gemini), which is governed and
 *    brakes on 429 since the J5 reversal.
 *
 * Evidence is printed as rate-limit header names and values only: never keys,
 * request bodies or response bodies.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { GeminiProvider } from '../providers/gemini.js';
import { anthropicQuotaDialect, openaiQuotaDialect } from '../providers/quota.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { CallTiming } from '../types.js';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

const PROMPT: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: pong' }];
const PNG_BASE64 = readFileSync(
  new URL('../../../../docs/assets/studio-playground.png', import.meta.url),
).toString('base64');

/** Header names that carry quota state. Values are counts, not secrets. */
const QUOTA_HEADER = /ratelimit|retry-after|quota/i;

/** Wrap fetch to record the quota headers of every response, in order. */
function recordHeaders(): { seen: Array<{ status: number; headers: Headers }> } {
  const seen: Array<{ status: number; headers: Headers }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await real(...args);
    seen.push({ status: res.status, headers: res.headers });
    return res;
  }) as typeof fetch;
  restore.push(() => {
    globalThis.fetch = real;
  });
  return { seen };
}
const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

function quotaHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    if (QUOTA_HEADER.test(name)) out[name] = value;
  });
  return out;
}

function evidence(row: string, data: unknown): void {
  console.log(`[live ${row}] ${JSON.stringify(data)}`);
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<CallTiming | undefined> {
  let timing: CallTiming | undefined;
  for await (const chunk of gen) {
    if (chunk.type === 'done') timing = chunk.timing;
  }
  return timing;
}

async function chatAndStream(
  row: string,
  provider: Provider,
  model: string,
  extra: Partial<ChatOptions> = {},
): Promise<Array<{ status: number; headers: Headers }>> {
  const { seen } = recordHeaders();
  const opts = { model, maxTokens: 32, ...extra };
  const res = await provider.chat(PROMPT, opts);
  expect(res.content.length).toBeGreaterThan(0);
  await drain(provider.stream(PROMPT, opts));
  expect(seen).toHaveLength(2);
  evidence(row, {
    model,
    nonStream: { status: seen[0].status, quota: quotaHeaders(seen[0].headers) },
    stream: { status: seen[1].status, quota: quotaHeaders(seen[1].headers) },
  });
  return seen;
}

function expectLanes(h: Headers, lanes: string[]): void {
  for (const lane of lanes) {
    const limit = h.get(lane.replace('{kind}', 'limit'));
    const remaining = h.get(lane.replace('{kind}', 'remaining'));
    expect(limit, `${lane} limit`).toMatch(/^\d+$/);
    expect(remaining, `${lane} remaining`).toMatch(/^\d+$/);
  }
}

describe.skipIf(!OPENAI_KEY)('L1: OpenAI 2xx quota headers (gpt-5.6-luna)', () => {
  it('non-stream and stream both carry request and token lanes that hint parses', async () => {
    const seen = await chatAndStream(
      'L1',
      new OpenAIProvider({ apiKey: OPENAI_KEY! }),
      'gpt-5.6-luna',
      { effort: 'none' },
    );
    for (const { status, headers } of seen) {
      expect(status).toBe(200);
      expectLanes(headers, ['x-ratelimit-{kind}-requests', 'x-ratelimit-{kind}-tokens']);
      const hint = openaiQuotaDialect.hint(headers);
      expect(hint).toBeGreaterThanOrEqual(0);
      expect(hint).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

describe.skipIf(!ANTHROPIC_KEY)('L2: Anthropic 2xx quota headers (claude-haiku-4-5)', () => {
  it('non-stream and stream both carry the anthropic-ratelimit lanes that hint parses', async () => {
    const seen = await chatAndStream(
      'L2',
      new AnthropicProvider({ apiKey: ANTHROPIC_KEY! }),
      'claude-haiku-4-5',
    );
    for (const { status, headers } of seen) {
      expect(status).toBe(200);
      expectLanes(headers, [
        'anthropic-ratelimit-requests-{kind}',
        'anthropic-ratelimit-input-tokens-{kind}',
        'anthropic-ratelimit-output-tokens-{kind}',
      ]);
      const hint = anthropicQuotaDialect.hint(headers);
      expect(hint).toBeGreaterThanOrEqual(0);
      expect(hint).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

describe.skipIf(!GOOGLE_KEY)('L4: Gemini 2xx headers (gemini-3.6-flash)', () => {
  it('records which quota headers Gemini sends, if any', async () => {
    const { seen } = recordHeaders();
    const provider = new GeminiProvider({ apiKey: GOOGLE_KEY! });
    await provider.chat(PROMPT, { model: 'gemini-3.6-flash', maxTokens: 32 });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const names: string[] = [];
    seen[0].headers.forEach((_v, name) => names.push(name));
    evidence('L4', {
      status: seen[0].status,
      quota: quotaHeaders(seen[0].headers),
      headerNames: names.sort(),
    });
    expect(seen[0].status).toBe(200);
  }, 60_000);
});

describe.skipIf(!GOOGLE_KEY)('L10: zero added wait on a dialect-less scope (Gemini)', () => {
  it('concurrent calls with no rateLimit report queuedMs 0 and one attempt', async () => {
    const { seen } = recordHeaders();
    const provider = new GeminiProvider({ apiKey: GOOGLE_KEY! });
    const results = await Promise.all(
      [0, 1, 2].map(() => provider.chat(PROMPT, { model: 'gemini-3.6-flash', maxTokens: 32 })),
    );
    const timings = results.map((r) => r.timing);
    evidence('L10', { statuses: seen.map((s) => s.status), timings });
    expect(seen.every((s) => s.status === 200)).toBe(true);
    for (const t of timings) {
      expect(t).toBeDefined();
      expect(t!.queuedMs).toBe(0);
      expect(t!.attempts).toBe(1);
    }
  }, 60_000);
});

describe.skipIf(!ANTHROPIC_KEY)(
  'L8: zero added wait before any 429 on media and cached prompts',
  () => {
    it('image-heavy calls on a dialect scope with no rateLimit report queuedMs 0', async () => {
      const { seen } = recordHeaders();
      const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY! });
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Name one color in this image, one word.' },
            {
              type: 'image',
              label: 'studio screenshot',
              source: { type: 'base64', data: PNG_BASE64, mediaType: 'image/png' },
            },
          ],
        },
      ];
      const results = await Promise.all(
        [0, 1, 2].map(() => provider.chat(messages, { model: 'claude-haiku-4-5', maxTokens: 5 })),
      );
      const timings = results.map((r) => r.timing);
      evidence('L8-image', {
        imageBase64Bytes: PNG_BASE64.length,
        statuses: seen.map((s) => s.status),
        timings,
      });
      expect(seen.every((s) => s.status === 200)).toBe(true);
      for (const t of timings) {
        expect(t).toBeDefined();
        expect(t!.queuedMs).toBe(0);
        expect(t!.attempts).toBe(1);
      }
    }, 90_000);

    it('cached-prompt calls on a dialect scope with no rateLimit report queuedMs 0', async () => {
      const { seen } = recordHeaders();
      const provider = new AnthropicProvider({ apiKey: ANTHROPIC_KEY! });
      // A unique prefix well past Sonnet's cache minimum.
      const prefix =
        `run ${randomUUID()}\n` + 'The quick brown fox jumps over the lazy dog. '.repeat(300);
      const messages: ChatMessage[] = [
        { role: 'system', content: prefix },
        { role: 'user', content: 'Say hi.' },
      ];
      const opts = {
        model: 'claude-sonnet-5',
        maxTokens: 64,
        effort: 'low' as const,
        promptCache: true,
      };
      const first = await provider.chat(messages, opts);
      const second = await provider.chat(messages, opts);
      evidence('L8-cache', {
        statuses: seen.map((s) => s.status),
        firstCacheWrite: first.usage?.cache_write_tokens,
        secondCacheRead: second.usage?.cached_tokens,
        timings: [first.timing, second.timing],
      });
      expect(second.usage?.cached_tokens ?? 0).toBeGreaterThan(1000);
      for (const t of [first.timing, second.timing]) {
        expect(t!.queuedMs).toBe(0);
        expect(t!.attempts).toBe(1);
      }
    }, 90_000);
  },
);
