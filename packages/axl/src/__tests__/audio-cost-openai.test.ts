/**
 * Modality-aware audio cost estimation — `openai:` Chat Completions.
 *
 * Frozen matrix rows implemented here: T001–T014, T016, T021–T026, T028–T036,
 * T070–T072, T076, T077 (openai half), T080, T081, T085, plus plan gaps G2 and
 * G10. Rows deliberately not implemented, with reasons, are listed in
 * `.internal/plans/core-sdk/active/audio-cost-estimation/implementation-report.md`.
 *
 * Every priced row asserts an EXACT total built from the published rates below,
 * never "greater than zero": a text-rate implementation, a dropped audio
 * bucket, or a double-counted one all produce a different number.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { isUnpricedLeaf } from '../event-utils.js';
import { OpenAIProvider, estimateDirectOpenAICost } from '../providers/openai.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent, ProviderResponse } from '../types.js';
import { workflow } from '../workflow.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Published rates (the fixture's independent copy of the catalog) ──────
//
// Reviewed 2026-09-08 against https://developers.openai.com/api/docs/pricing.
// `AUDIO_IN` is ~13x `TEXT_IN` on purpose: that gap is what makes every exact
// assertion below discriminating (matrix T003).

const M = 1_000_000;
const TEXT_IN = 2.5 / M;
const TEXT_OUT = 10 / M;
const AUDIO_IN = 32 / M;
const AUDIO_OUT = 64 / M;
const AUDIO_MODEL = 'gpt-audio-1.5';

/** GA2-text's live usage vector (verification record 2026-09-08). */
const GA2 = { prompt: 107, audio: 80, completion: 12 } as const;
const GA2_EXPECTED =
  (GA2.prompt - GA2.audio) * TEXT_IN + GA2.audio * AUDIO_IN + GA2.completion * TEXT_OUT;
/** What a text-rate implementation would report for the same vector. */
const GA2_ALL_TEXT_RATES = GA2.prompt * TEXT_IN + GA2.completion * TEXT_OUT;

// ── Harness ─────────────────────────────────────────────────────────────

const SENTINEL = Buffer.from('AUDIOCOSTSENTINEL').toString('base64');

const AUDIO_INPUT = [
  {
    type: 'audio' as const,
    source: { type: 'base64' as const, data: SENTINEL, mediaType: 'audio/wav' },
  },
  { type: 'text' as const, text: 'What is in this recording?' },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  fetchMock.mockResolvedValue(responses[responses.length - 1]);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

/** A Chat Completions reply carrying a crafted usage body verbatim. */
function reply(usage: Record<string, unknown>, model?: string): Response {
  return jsonResponse({
    ...(model !== undefined ? { model } : {}),
    choices: [{ message: { content: 'a phone call' }, finish_reason: 'stop' }],
    usage,
  });
}

/** `prompt_tokens_details.audio_tokens` set to an arbitrary wire value. */
function usageWithAudio(
  audio: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt_tokens: GA2.prompt,
    completion_tokens: GA2.completion,
    total_tokens: GA2.prompt + GA2.completion,
    prompt_tokens_details: { audio_tokens: audio },
    ...over,
  };
}

type AskResult = { cost: number | undefined; usage: ProviderResponse['usage'] };

/**
 * One audio-bearing ask through the real adapter and a stubbed transport, so
 * the assertion covers request mapping, usage normalization, and pricing.
 */
async function askAudio(
  usage: Record<string, unknown>,
  options: {
    model?: string;
    responseModel?: string;
    baseUrl?: string;
    providerOptions?: Record<string, unknown>;
    input?: unknown;
  } = {},
): Promise<AskResult> {
  mockFetch(reply(usage, options.responseModel));
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  const response = await provider.chat(
    [{ role: 'user', content: (options.input ?? AUDIO_INPUT) as never }],
    {
      model: options.model ?? AUDIO_MODEL,
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
    },
  );
  return { cost: response.cost, usage: response.usage };
}

function openAIRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider('openai', new OpenAIProvider({ apiKey: 'test-key' }));
  return runtime;
}

// ── The formula (T001, T003, T004, T006, T030) ──────────────────────────

describe('openai audio pricing formula', () => {
  it('T001: prices the GA2-text usage vector at text + audio + output rates', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio));
    expect(cost).toBeCloseTo(GA2_EXPECTED, 12);
  });

  it('T003: the asserted total is NOT the all-text-rate total', async () => {
    // The guard that makes every other row discriminating: if the estimator
    // billed the 80 audio tokens at the text input rate, T001 would have to
    // equal GA2_ALL_TEXT_RATES. It must not.
    expect(GA2_EXPECTED).not.toBeCloseTo(GA2_ALL_TEXT_RATES, 12);
    const { cost } = await askAudio(usageWithAudio(GA2.audio));
    expect(cost).not.toBeCloseTo(GA2_ALL_TEXT_RATES, 12);
    // And it is strictly larger — audio is the expensive modality.
    expect(cost!).toBeGreaterThan(GA2_ALL_TEXT_RATES);
  });

  it('T004: audio_tokens === prompt_tokens leaves a zero text term', async () => {
    const { cost } = await askAudio(
      usageWithAudio(GA2.prompt, { completion_tokens: GA2.completion }),
    );
    expect(cost).toBeCloseTo(GA2.prompt * AUDIO_IN + GA2.completion * TEXT_OUT, 12);
  });

  it('T006: audio_tokens === 0 on an audio request prices as pure text', async () => {
    const { cost } = await askAudio(usageWithAudio(0));
    expect(cost).toBeCloseTo(GA2_ALL_TEXT_RATES, 12);
  });

  it('T030: a zero-token response prices to exactly 0, distinguishable from unknown', async () => {
    const { cost } = await askAudio({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { audio_tokens: 0 },
    });
    expect(cost).toBe(0);
    expect(cost).not.toBeUndefined();
  });

  it('T036: pricing the same body twice yields the identical number', async () => {
    const first = await askAudio(usageWithAudio(GA2.audio));
    const second = await askAudio(usageWithAudio(GA2.audio));
    expect(first.cost).toBe(second.cost);
  });
});

// ── Missing / malformed audio counts (T005, T007–T014, T016) ────────────

describe('openai audio preconditions report unknown, never zero', () => {
  it('T002: a model with no audio rate stays unpriced', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), { model: 'gpt-4o' });
    expect(cost).toBeUndefined();
  });

  it('T005: audio_tokens > prompt_tokens is unpriced, never a negative text term', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.prompt + 1));
    expect(cost).toBeUndefined();
  });

  it('T007: prompt_tokens_details absent on an audio request is unpriced', async () => {
    const { cost } = await askAudio({
      prompt_tokens: GA2.prompt,
      completion_tokens: GA2.completion,
      total_tokens: GA2.prompt + GA2.completion,
    });
    expect(cost).toBeUndefined();
  });

  it('T008: details present without audio_tokens is unpriced — absent is not zero', async () => {
    const { cost } = await askAudio({
      prompt_tokens: GA2.prompt,
      completion_tokens: GA2.completion,
      total_tokens: GA2.prompt + GA2.completion,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(cost).toBeUndefined();
    // T006 vs T008: the same request shape with an explicit `0` DOES price.
    const zero = await askAudio(usageWithAudio(0));
    expect(zero.cost).toBeCloseTo(GA2_ALL_TEXT_RATES, 12);
  });

  it.each([
    ['T009 negative', -1],
    ['T010 non-integer', 12.5],
    ['T011 string', '80'],
    ['T012 null', null],
    ['T013 non-finite as a string', 'NaN'],
    ['T014 above MAX_SAFE_INTEGER', 1e18],
    ['boolean', true],
  ])('%s audio_tokens is unpriced and never poisons the total', async (_label, value) => {
    const { cost } = await askAudio(usageWithAudio(value));
    expect(cost).toBeUndefined();
    expect(Number.isNaN(cost as number)).toBe(false);
  });

  it('T016: a cache hit on an audio model with no published cached rate is unpriced', async () => {
    // `gpt-audio-1.5` publishes no cached-input row, so a reported cache hit
    // has no rate — the honest answer is unknown, not the full input rate.
    const { cost } = await askAudio(
      usageWithAudio(GA2.audio, {
        prompt_tokens_details: { audio_tokens: GA2.audio, cached_tokens: 10 },
      }),
    );
    expect(cost).toBeUndefined();
  });

  it('G2: audio + cached exceeding the prompt total is unpriced', () => {
    expect(
      estimateDirectOpenAICost(AUDIO_MODEL, {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        audio_input_tokens: 80,
        cached_tokens: 30,
      }),
    ).toBeUndefined();
  });
});

// ── Audio output (T021, E14) ────────────────────────────────────────────

describe('openai audio output tokens', () => {
  it('E14: spoken output prices at the audio OUTPUT rate, not the text one', async () => {
    const { cost } = await askAudio(
      usageWithAudio(GA2.audio, {
        completion_tokens: 20,
        completion_tokens_details: { audio_tokens: 8 },
      }),
      { providerOptions: { modalities: ['text', 'audio'] } },
    );
    expect(cost).toBeCloseTo(
      (GA2.prompt - GA2.audio) * TEXT_IN + GA2.audio * AUDIO_IN + 12 * TEXT_OUT + 8 * AUDIO_OUT,
      12,
    );
  });

  it('T021 (per plan §8): a model with no audio output rate is unpriced with modalities: audio', async () => {
    const { cost } = await askAudio(usageWithAudio(0), {
      model: 'gpt-4o',
      providerOptions: { modalities: ['text', 'audio'] },
    });
    expect(cost).toBeUndefined();
  });

  it('audio output tokens exceeding the completion total are unpriced', async () => {
    const { cost } = await askAudio(
      usageWithAudio(GA2.audio, {
        completion_tokens: 5,
        completion_tokens_details: { audio_tokens: 6 },
      }),
      { providerOptions: { modalities: ['text', 'audio'] } },
    );
    expect(cost).toBeUndefined();
  });

  it('a request-level audio config on an unrated model is unpriced', async () => {
    const { cost } = await askAudio(usageWithAudio(0), {
      model: 'gpt-4o',
      providerOptions: { audio: { voice: 'alloy', format: 'wav' } },
    });
    expect(cost).toBeUndefined();
  });
});

// ── Request-shape eligibility (T022–T026, T028, T029, T031) ─────────────

describe('openai audio eligibility', () => {
  const AUDIO_WIRE_PART = { type: 'input_audio', input_audio: { data: SENTINEL, format: 'wav' } };
  const audioUsage = {
    prompt_tokens: GA2.prompt,
    completion_tokens: GA2.completion,
    total_tokens: GA2.prompt + GA2.completion,
    audio_input_tokens: GA2.audio,
  };

  it('T022: an image part alongside audio is unmodeled', () => {
    expect(
      estimateDirectOpenAICost(AUDIO_MODEL, audioUsage, {
        request: {
          messages: [
            {
              role: 'user',
              content: [
                AUDIO_WIRE_PART,
                { type: 'image_url', image_url: { url: 'https://x/y.png' } },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('T023: a non-audio non-text part in HISTORY is unmodeled even when the turn is audio', () => {
    expect(
      estimateDirectOpenAICost(AUDIO_MODEL, audioUsage, {
        request: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
            },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: [AUDIO_WIRE_PART] },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('the same history without the image part prices', () => {
    // Negative control for T023: the history walk is what rejects, not the
    // multi-message shape itself.
    expect(
      estimateDirectOpenAICost(AUDIO_MODEL, audioUsage, {
        request: {
          messages: [
            { role: 'user', content: 'earlier' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: [AUDIO_WIRE_PART] },
          ],
        },
      }),
    ).toBeCloseTo(GA2_EXPECTED, 12);
  });

  it('a malformed audio part is unmodeled rather than assumed to be audio', () => {
    expect(
      estimateDirectOpenAICost(AUDIO_MODEL, audioUsage, {
        request: { messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] },
      }),
    ).toBeUndefined();
  });

  it('T024: a non-canonical baseUrl is unpriced — deployment billing is not inferred', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), {
      baseUrl: 'https://proxy.internal.example.com/v1',
    });
    expect(cost).toBeUndefined();
  });

  it('T025: a non-standard service tier is unpriced', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), {
      providerOptions: { service_tier: 'flex' },
    });
    expect(cost).toBeUndefined();
  });

  it.each([
    ['absent', undefined],
    ['default', 'default'],
    ['standard', 'standard'],
  ])('T026: service_tier %s prices at standard rates', async (_label, tier) => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), {
      ...(tier === undefined ? {} : { providerOptions: { service_tier: tier } }),
    });
    expect(cost).toBeCloseTo(GA2_EXPECTED, 12);
  });

  it('T028: an arbitrary suffix inherits no audio rate', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), {
      model: 'gpt-audio-1.5-frobnicate',
    });
    expect(cost).toBeUndefined();
  });

  it('T029: pricing follows the EFFECTIVE model the response reports', async () => {
    const { cost } = await askAudio(usageWithAudio(GA2.audio), { responseModel: 'gpt-4o' });
    // `gpt-4o` has no audio rate, so serving the call on it is unpriced —
    // proving the requested id is not what priced T001.
    expect(cost).toBeUndefined();
  });

  it('T031: a reported audio bucket on a text-only request prices from the audio row', async () => {
    // Usage is authoritative (plan G10): the count is real billing.
    const { cost } = await askAudio(usageWithAudio(GA2.audio), { input: 'Describe the weather.' });
    expect(cost).toBeCloseTo(GA2_EXPECTED, 12);
  });

  it('T032: a text-only ask on the audio model keeps exact text pricing', async () => {
    const { cost } = await askAudio(
      {
        prompt_tokens: GA2.prompt,
        completion_tokens: GA2.completion,
        total_tokens: GA2.prompt + GA2.completion,
      },
      { input: 'Describe the weather.' },
    );
    expect(cost).toBeCloseTo(GA2_ALL_TEXT_RATES, 12);
  });
});

// ── Usage normalization (T070–T072, T076, T077) ─────────────────────────

describe('openai audio usage normalization', () => {
  it('T070/T071: reports the prompt and completion audio buckets', async () => {
    const { usage } = await askAudio(
      usageWithAudio(GA2.audio, {
        completion_tokens: 20,
        completion_tokens_details: { audio_tokens: 5 },
      }),
      { providerOptions: { modalities: ['text', 'audio'] } },
    );
    expect(usage?.audio_input_tokens).toBe(GA2.audio);
    expect(usage?.audio_output_tokens).toBe(5);
    // `prompt_tokens` stays the folded total for existing consumers.
    expect(usage?.prompt_tokens).toBe(GA2.prompt);
  });

  it('T072: no audio detail means the fields are ABSENT, not 0', async () => {
    const { usage } = await askAudio(
      {
        prompt_tokens: GA2.prompt,
        completion_tokens: GA2.completion,
        total_tokens: GA2.prompt + GA2.completion,
      },
      { input: 'Describe the weather.' },
    );
    expect('audio_input_tokens' in (usage ?? {})).toBe(false);
    expect('audio_output_tokens' in (usage ?? {})).toBe(false);
  });

  it('T072: an explicit 0 is PRESENT and 0', async () => {
    const { usage } = await askAudio(usageWithAudio(0));
    expect('audio_input_tokens' in (usage ?? {})).toBe(true);
    expect(usage?.audio_input_tokens).toBe(0);
  });

  it('T076: a malformed count is omitted rather than propagated', async () => {
    const { usage } = await askAudio(usageWithAudio(-1));
    expect('audio_input_tokens' in (usage ?? {})).toBe(false);
  });
});

// ── Streaming parity (T034, T035, T077) ─────────────────────────────────

describe('openai audio streaming', () => {
  const doneUsage = JSON.stringify({
    prompt_tokens: GA2.prompt,
    completion_tokens: GA2.completion,
    total_tokens: GA2.prompt + GA2.completion,
    prompt_tokens_details: { audio_tokens: GA2.audio },
  });

  async function streamDone(lines: string[]) {
    mockFetch(sseResponse(lines));
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const chunks = [];
    for await (const chunk of provider.stream([{ role: 'user', content: AUDIO_INPUT as never }], {
      model: AUDIO_MODEL,
    })) {
      chunks.push(chunk);
    }
    const done = chunks.find((chunk) => chunk.type === 'done');
    if (done?.type !== 'done') throw new Error('no done chunk');
    return done;
  }

  it('T034/T077: the done chunk carries the same cost and audio fields as chat()', async () => {
    const done = await streamDone([
      'data: {"choices":[{"delta":{"content":"a phone call"},"finish_reason":null}]}',
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":${doneUsage}}`,
      'data: [DONE]',
    ]);
    expect(done.cost).toBeCloseTo(GA2_EXPECTED, 12);
    expect(done.usage?.audio_input_tokens).toBe(GA2.audio);
    const nonStreaming = await askAudio(usageWithAudio(GA2.audio));
    expect(done.cost).toBe(nonStreaming.cost);
  });

  it('T035: a stream that reports no usage is unpriced and still carries timing', async () => {
    const done = await streamDone([
      'data: {"choices":[{"delta":{"content":"a phone call"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);
    expect(done.cost).toBeUndefined();
    expect(done.timing).toBeDefined();
  });
});

// ── Budget rail (T080, T081, T085, T033) ────────────────────────────────

describe('openai audio budget enforcement', () => {
  /** A priced audio ask worth ~$0.0027, so two of them cross a $0.004 cap. */
  function pricedAudioResponses(count: number): Response[] {
    return Array.from({ length: count }, () => reply(usageWithAudio(GA2.audio)));
  }

  it('T081: a hard_stop cost budget ENFORCES on priced audio asks', async () => {
    const fetchMock = mockFetch(...pricedAudioResponses(4));
    const runtime = openAIRuntime();
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const completed: number[] = [];
    runtime.register(
      workflow({
        name: 'audio-budget-hard-stop',
        input: z.object({}),
        handler: async (ctx) => {
          const listener = agent({ model: `openai:${AUDIO_MODEL}`, system: 'Listen.' });
          return ctx.budget({ cost: '$0.004', onExceed: 'hard_stop' }, async () => {
            // One ask costs $0.0027475, so the cap admits exactly one.
            for (let turn = 0; turn < 3; turn++) {
              await ctx.ask(listener, AUDIO_INPUT as never);
              completed.push(turn);
            }
            return 'never';
          });
        },
      }),
    );

    const result = (await runtime.execute('audio-budget-hard-stop', {})) as {
      budgetExceeded: boolean;
      unpriced: boolean;
      totalCost: number;
      value: unknown;
    };
    // Enforcement, not reporting: the block stopped, the loop never finished,
    // and the third ask was never dispatched. A build that leaves audio
    // unpriced completes all three asks and returns 'never'.
    expect(result.budgetExceeded).toBe(true);
    expect(result.unpriced).toBe(false);
    expect(result.value).toBeNull();
    expect(completed).toEqual([0]);
    expect(fetchMock.mock.calls.length).toBeLessThan(3);
    expect(result.totalCost).toBeCloseTo(GA2_EXPECTED * fetchMock.mock.calls.length, 12);
    for (const callEnd of events.filter((event) => event.type === 'agent_call_end')) {
      expect(isUnpricedLeaf(callEnd)).toBe(false);
      expect(callEnd.type === 'agent_call_end' && callEnd.cost).toBeCloseTo(GA2_EXPECTED, 12);
    }
    await runtime.shutdown();
  });

  it('T080/T085: a fully priced audio block reports unpriced: false and exact spend', async () => {
    mockFetch(...pricedAudioResponses(2));
    const runtime = openAIRuntime();
    runtime.register(
      workflow({
        name: 'audio-budget-report',
        input: z.object({}),
        handler: async (ctx) => {
          const status = await ctx.budget({ cost: '$1.00' }, async () => {
            await ctx.ask(
              agent({ model: `openai:${AUDIO_MODEL}`, system: 'Listen.' }),
              AUDIO_INPUT as never,
            );
            return ctx.getBudgetStatus();
          });
          return status;
        },
      }),
    );

    const result = (await runtime.execute('audio-budget-report', {})) as {
      unpriced: boolean;
      totalCost: number;
      value: { spent: number; remaining: number; unpriced: boolean } | null;
    };
    expect(result.unpriced).toBe(false);
    expect(result.totalCost).toBeCloseTo(GA2_EXPECTED, 12);
    expect(result.value?.unpriced).toBe(false);
    expect(result.value?.spent).toBeCloseTo(GA2_EXPECTED, 12);
    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(false);
    expect(info.totalCost).toBeCloseTo(GA2_EXPECTED, 12);
    await runtime.shutdown();
  });

  it('T033: two turns with different audio counts each price from their own usage', async () => {
    mockFetch(reply(usageWithAudio(80)), reply(usageWithAudio(40)));
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const first = await provider.chat([{ role: 'user', content: AUDIO_INPUT as never }], {
      model: AUDIO_MODEL,
    });
    const second = await provider.chat([{ role: 'user', content: AUDIO_INPUT as never }], {
      model: AUDIO_MODEL,
    });
    expect(first.cost).toBeCloseTo(GA2_EXPECTED, 12);
    expect(second.cost).toBeCloseTo(
      (GA2.prompt - 40) * TEXT_IN + 40 * AUDIO_IN + GA2.completion * TEXT_OUT,
      12,
    );
    // A turn-1 audio count reused for turn 2 would make these equal.
    expect(first.cost).not.toBeCloseTo(second.cost!, 12);
  });
});
