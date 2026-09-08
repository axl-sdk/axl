/**
 * Modality-aware audio cost estimation — `google:` Gemini Interactions.
 *
 * Frozen matrix rows implemented here: T038–T058, T060–T063, T073, T074,
 * T077 (google half), T082-shaped budget enforcement. Rows deliberately not
 * implemented, with reasons, are in the workstream's implementation report.
 *
 * The discriminating model is `gemini-2.5-flash`, whose published AUDIO input
 * rate ($1.00 / 1M) is more than 3x its text/image rate ($0.30 / 1M): an
 * implementation that bills audio at the input rate, or text/image at the
 * audio rate, produces a different number on every priced row below.
 * `gemini-3.7-flash` (audio == input) is the second model, and the pair is
 * what kills a single shared audio constant (T039).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { isUnpricedLeaf } from '../event-utils.js';
import { GeminiProvider } from '../providers/gemini.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent, ChatMessage, ProviderResponse } from '../types.js';
import { workflow } from '../workflow.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Published rates (the fixture's independent copy of the catalog) ──────
//
// Reviewed 2026-09-08 against https://ai.google.dev/gemini-api/docs/pricing.

const RATES = {
  'gemini-2.5-flash': { input: 0.3e-6, cached: 0.03e-6, output: 2.5e-6, audio: 1e-6 },
  'gemini-3.7-flash': { input: 0.75e-6, cached: 0.075e-6, output: 3.75e-6, audio: 0.75e-6 },
} as const;

const SPLIT_MODEL = 'gemini-2.5-flash';
/** No `audioInput` rate: a rich Interactions call on it must stay unpriced. */
const UNRATED_MODEL = 'gemini-2.5-pro';

/** GA1's live usage vector (verification record 2026-09-08). */
const GA1 = { audio: 75, text: 20, input: 95, output: 12, thought: 55 } as const;

function expectedCost(
  model: keyof typeof RATES,
  vector: { audio: number; nonAudio: number; output: number; thought?: number; cached?: number },
): number {
  const rate = RATES[model];
  const cached = vector.cached ?? 0;
  return (
    (vector.nonAudio - cached) * rate.input +
    cached * rate.cached +
    vector.audio * rate.audio +
    (vector.output + (vector.thought ?? 0)) * rate.output
  );
}

const GA1_EXPECTED = expectedCost(SPLIT_MODEL, {
  audio: GA1.audio,
  nonAudio: GA1.text,
  output: GA1.output,
  thought: GA1.thought,
});
/** What billing every input token at the text rate would report. */
const GA1_ALL_TEXT_RATES =
  GA1.input * RATES[SPLIT_MODEL].input + (GA1.output + GA1.thought) * RATES[SPLIT_MODEL].output;
/** What billing every input token at the AUDIO rate would report. */
const GA1_ALL_AUDIO_RATES =
  GA1.input * RATES[SPLIT_MODEL].audio + (GA1.output + GA1.thought) * RATES[SPLIT_MODEL].output;

// ── Harness ─────────────────────────────────────────────────────────────

const SENTINEL = Buffer.from('GEMINIAUDIOCOST').toString('base64');

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

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  fetchMock.mockResolvedValue(responses[responses.length - 1]);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

type Modality = { modality: unknown; tokens: unknown };

/** GA1's wire usage shape, with any field overridden. */
function interactionUsage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_input_tokens: GA1.input,
    total_output_tokens: GA1.output,
    total_thought_tokens: GA1.thought,
    total_tokens: GA1.input + GA1.output + GA1.thought,
    input_tokens_by_modality: [
      { modality: 'audio', tokens: GA1.audio },
      { modality: 'text', tokens: GA1.text },
    ] satisfies Modality[],
    ...over,
  };
}

function interactionReply(
  usage: Record<string, unknown> | undefined,
  over: Record<string, unknown> = {},
): Response {
  return jsonResponse({
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A rising tone.' }] }],
    ...(usage ? { usage } : {}),
    ...over,
  });
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

type AskResult = { cost: number | undefined; usage: ProviderResponse['usage'] };

/** One rich (Interactions) ask through the real adapter and a stubbed wire. */
async function askAudio(
  usage: Record<string, unknown> | undefined,
  options: {
    model?: string;
    baseUrl?: string;
    providerOptions?: Record<string, unknown>;
    responseOver?: Record<string, unknown>;
    input?: readonly unknown[];
  } = {},
): Promise<AskResult> {
  mockFetch(interactionReply(usage, options.responseOver));
  const provider = new GeminiProvider({
    apiKey: 'test-key',
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  const messages: ChatMessage[] = [
    { role: 'user', content: (options.input ?? AUDIO_INPUT) as never },
  ];
  const response = await provider.chat(messages, {
    model: options.model ?? SPLIT_MODEL,
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
  });
  return { cost: response.cost, usage: response.usage };
}

function googleRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider('google', new GeminiProvider({ apiKey: 'test-key' }));
  return runtime;
}

// ── The per-modality formula (T038, T039, T041, T051, T052) ─────────────

describe('gemini per-modality pricing formula', () => {
  it('T038: prices the GA1 vector from the modality split', async () => {
    const { cost } = await askAudio(interactionUsage());
    expect(cost).toBeCloseTo(GA1_EXPECTED, 14);
  });

  it('T038 guard: the total is neither the all-text nor the all-audio total', async () => {
    // Kills both directions of the invariant in one row: audio at the text
    // rate, and text/image at the audio rate.
    const { cost } = await askAudio(interactionUsage());
    expect(cost).not.toBeCloseTo(GA1_ALL_TEXT_RATES, 14);
    expect(cost).not.toBeCloseTo(GA1_ALL_AUDIO_RATES, 14);
    expect(cost!).toBeGreaterThan(GA1_ALL_TEXT_RATES);
    expect(cost!).toBeLessThan(GA1_ALL_AUDIO_RATES);
  });

  it('T039: the same vector prices differently per model — no shared audio constant', async () => {
    const flash25 = await askAudio(interactionUsage(), { model: 'gemini-2.5-flash' });
    const flash37 = await askAudio(interactionUsage(), { model: 'gemini-3.7-flash' });
    expect(flash25.cost).toBeCloseTo(GA1_EXPECTED, 14);
    expect(flash37.cost).toBeCloseTo(
      expectedCost('gemini-3.7-flash', {
        audio: GA1.audio,
        nonAudio: GA1.text,
        output: GA1.output,
        thought: GA1.thought,
      }),
      14,
    );
    expect(flash25.cost).not.toBeCloseTo(flash37.cost!, 14);
    // 3.7 Flash publishes ONE input price, so there the audio and text rates
    // legitimately coincide — which is exactly why 2.5 Flash is the fence.
    expect(flash37.cost).toBeCloseTo(
      GA1.input * RATES['gemini-3.7-flash'].input +
        (GA1.output + GA1.thought) * RATES['gemini-3.7-flash'].output,
      14,
    );
  });

  it('T041: image tokens bill at the INPUT rate, audio at the audio rate', async () => {
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens: 40 },
          { modality: 'image', tokens: 35 },
          { modality: 'text', tokens: 20 },
        ],
      }),
    );
    expect(cost).toBeCloseTo(
      expectedCost(SPLIT_MODEL, {
        audio: 40,
        nonAudio: 55,
        output: GA1.output,
        thought: GA1.thought,
      }),
      14,
    );
    // Pricing the image bucket at the audio rate would add 35 × ($1 − $0.30)/1M.
    expect(cost).not.toBeCloseTo(
      expectedCost(SPLIT_MODEL, {
        audio: 75,
        nonAudio: 20,
        output: GA1.output,
        thought: GA1.thought,
      }),
      14,
    );
  });

  it('T051/T052: thought tokens bill at the output rate and only when reported', async () => {
    const withThoughts = await askAudio(interactionUsage());
    const withoutThoughts = await askAudio(
      interactionUsage({
        total_thought_tokens: undefined,
        total_tokens: GA1.input + GA1.output,
      }),
    );
    expect(withoutThoughts.cost).toBeCloseTo(
      expectedCost(SPLIT_MODEL, { audio: GA1.audio, nonAudio: GA1.text, output: GA1.output }),
      14,
    );
    // A phantom thought term would make these equal.
    expect(withThoughts.cost).not.toBeCloseTo(withoutThoughts.cost!, 14);
    expect(withThoughts.cost! - withoutThoughts.cost!).toBeCloseTo(
      GA1.thought * RATES[SPLIT_MODEL].output,
      14,
    );
  });

  it('T050: tool-use prompt tokens explicitly 0 still price', async () => {
    const { cost } = await askAudio(interactionUsage({ total_tool_use_tokens: 0 }));
    expect(cost).toBeCloseTo(GA1_EXPECTED, 14);
  });

  it('T063: pricing the same body twice yields the identical number', async () => {
    const first = await askAudio(interactionUsage());
    const second = await askAudio(interactionUsage());
    expect(first.cost).toBe(second.cost);
  });
});

// ── Cached tokens (T053, T054) ──────────────────────────────────────────

describe('gemini cached tokens are deducted from the non-audio modalities only', () => {
  it('T053: cached bills at the cached rate, taken out of text/image', async () => {
    const { cost } = await askAudio(interactionUsage({ total_cached_tokens: 15 }));
    expect(cost).toBeCloseTo(
      expectedCost(SPLIT_MODEL, {
        audio: GA1.audio,
        nonAudio: GA1.text,
        output: GA1.output,
        thought: GA1.thought,
        cached: 15,
      }),
      14,
    );
    // Deducting the cached tokens from the AUDIO bucket instead would be
    // cheaper by 15 × ($1.00 − $0.30)/1M — this number rules that out.
    expect(cost).not.toBeCloseTo(
      (GA1.text - 0) * RATES[SPLIT_MODEL].input +
        15 * RATES[SPLIT_MODEL].cached +
        (GA1.audio - 15) * RATES[SPLIT_MODEL].audio +
        (GA1.output + GA1.thought) * RATES[SPLIT_MODEL].output,
      14,
    );
  });

  it('T054: cached exceeding the non-audio portion is unpriced, never clamped', async () => {
    // 30 cached > 20 non-audio tokens: the text term would go negative.
    const { cost } = await askAudio(interactionUsage({ total_cached_tokens: 30 }));
    expect(cost).toBeUndefined();
  });

  it('cached equal to the non-audio portion prices with a zero text term', async () => {
    const { cost } = await askAudio(interactionUsage({ total_cached_tokens: GA1.text }));
    expect(cost).toBeCloseTo(
      GA1.text * RATES[SPLIT_MODEL].cached +
        GA1.audio * RATES[SPLIT_MODEL].audio +
        (GA1.output + GA1.thought) * RATES[SPLIT_MODEL].output,
      14,
    );
  });
});

// ── Breakdown validity (T040, T042–T049, T055–T058, T062) ──────────────

describe('gemini pricing preconditions report unknown, never zero', () => {
  it('T040: a model with no audio rate is unpriced even with a valid breakdown', async () => {
    const { cost } = await askAudio(interactionUsage(), { model: UNRATED_MODEL });
    expect(cost).toBeUndefined();
  });

  it.each([
    ['T042 video', 'video'],
    ['T043 an unknown modality', 'document'],
  ])('%s in the breakdown is unpriced', async (_label, modality) => {
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens: GA1.audio },
          { modality, tokens: GA1.text },
        ],
      }),
    );
    expect(cost).toBeUndefined();
  });

  it('T044: duplicate modality keys are summed, then reconciled', async () => {
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens: 70 },
          { modality: 'audio', tokens: 5 },
          { modality: 'text', tokens: GA1.text },
        ],
      }),
    );
    expect(cost).toBeCloseTo(GA1_EXPECTED, 14);
  });

  it.each([
    ['T045 one short', -1],
    ['T046 one over', 1],
  ])('%s of the input total is unpriced — no rounding allowance', async (_label, delta) => {
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens: GA1.audio },
          { modality: 'text', tokens: GA1.text + delta },
        ],
      }),
    );
    expect(cost).toBeUndefined();
  });

  it('T047: no breakdown at all keeps the pre-estimator behavior — unpriced', async () => {
    const { cost, usage } = await askAudio(
      interactionUsage({ input_tokens_by_modality: undefined }),
    );
    expect(cost).toBeUndefined();
    // Tokens are still reported: the call is unpriced for want of a split.
    expect(usage?.prompt_tokens).toBe(GA1.input);
    expect('audio_input_tokens' in (usage ?? {})).toBe(false);
  });

  it('T048: an empty breakdown array is unpriced when the input total is not 0', async () => {
    const { cost } = await askAudio(interactionUsage({ input_tokens_by_modality: [] }));
    expect(cost).toBeUndefined();
  });

  it('T049: non-zero tool-use prompt tokens are unpriced', async () => {
    const { cost } = await askAudio(interactionUsage({ total_tool_use_tokens: 7 }));
    expect(cost).toBeUndefined();
  });

  it.each([
    ['T057 negative', -1],
    ['T057 non-integer', 12.5],
    ['T057 a string', '75'],
    ['T057 null', null],
    ['T058 above MAX_SAFE_INTEGER', 1e18],
  ])('%s modality count is unpriced', async (_label, tokens) => {
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens },
          { modality: 'text', tokens: GA1.text },
        ],
      }),
    );
    expect(cost).toBeUndefined();
    expect(Number.isNaN(cost as number)).toBe(false);
  });

  it('a malformed breakdown entry is unpriced', async () => {
    const { cost } = await askAudio(
      interactionUsage({ input_tokens_by_modality: [{ tokens: GA1.input }] }),
    );
    expect(cost).toBeUndefined();
  });

  it('T055: a non-standard service tier is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage(), {
      providerOptions: { service_tier: 'SERVICE_TIER_PRIORITY' },
    });
    expect(cost).toBeUndefined();
  });

  it('a non-standard tier echoed on the response is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage({ service_tier: 'SERVICE_TIER_FLEX' }));
    expect(cost).toBeUndefined();
  });

  it('T056: a non-text reply part is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage(), {
      responseOver: {
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'A rising tone.' }] },
          { type: 'model_output', content: [{ type: 'audio', data: SENTINEL }] },
        ],
      },
    });
    expect(cost).toBeUndefined();
  });

  it('an echoed user_input audio part does NOT unprice the call', async () => {
    // Negative control for T056: only MODEL output is inspected, so a provider
    // that echoes the request back must not make the call unpriced.
    const { cost } = await askAudio(interactionUsage(), {
      responseOver: {
        steps: [
          { type: 'user_input', content: [{ type: 'audio', data: SENTINEL }] },
          { type: 'model_output', content: [{ type: 'text', text: 'A rising tone.' }] },
        ],
      },
    });
    expect(cost).toBeCloseTo(GA1_EXPECTED, 14);
  });

  it('a non-canonical baseUrl is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage(), {
      baseUrl: 'https://gemini-proxy.internal.example.com/v1beta',
    });
    expect(cost).toBeUndefined();
  });

  it('a server-side cache reference is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage(), {
      providerOptions: { cached_content: 'caches/abc123' },
    });
    expect(cost).toBeUndefined();
  });

  it('a non-function tool is unpriced', async () => {
    const { cost } = await askAudio(interactionUsage(), {
      providerOptions: { tools: [{ type: 'google_search' }] },
    });
    expect(cost).toBeUndefined();
  });

  it('T062 (plan G1): an image-only rich call on an audio-rated model IS priced', async () => {
    // Accepted behavior change, documented in docs/providers.md: with a valid
    // breakdown, text/image tokens bill at the input rate. Audio-gating the
    // estimator was the rejected alternative.
    const { cost } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [{ modality: 'image', tokens: GA1.input }],
      }),
      { input: [{ type: 'text' as const, text: 'What is in this image?' }] },
    );
    expect(cost).toBeCloseTo(
      expectedCost(SPLIT_MODEL, {
        audio: 0,
        nonAudio: GA1.input,
        output: GA1.output,
        thought: GA1.thought,
      }),
      14,
    );
  });
});

// ── Usage normalization (T073, T074) ────────────────────────────────────

describe('gemini audio usage normalization', () => {
  it('T073: reports the audio bucket while prompt_tokens stays the folded total', async () => {
    const { usage } = await askAudio(interactionUsage());
    expect(usage?.audio_input_tokens).toBe(GA1.audio);
    expect(usage?.prompt_tokens).toBe(GA1.input);
    expect(usage?.completion_tokens).toBe(GA1.output);
    expect(usage?.reasoning_tokens).toBe(GA1.thought);
  });

  it('T074: a breakdown with no audio entry omits the field rather than reporting 0', async () => {
    const { usage } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [{ modality: 'text', tokens: GA1.input }],
      }),
    );
    expect('audio_input_tokens' in (usage ?? {})).toBe(false);
  });

  it('reports the audio bucket even when the breakdown cannot be priced', async () => {
    // An unknown modality blocks pricing but does not make a well-formed audio
    // count wrong to report.
    const { cost, usage } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [
          { modality: 'audio', tokens: GA1.audio },
          { modality: 'video', tokens: GA1.text },
        ],
      }),
    );
    expect(cost).toBeUndefined();
    expect(usage?.audio_input_tokens).toBe(GA1.audio);
  });

  it('omits the field when the reported audio exceeds the input total', async () => {
    const { usage } = await askAudio(
      interactionUsage({
        input_tokens_by_modality: [{ modality: 'audio', tokens: GA1.input + 1 }],
      }),
    );
    expect('audio_input_tokens' in (usage ?? {})).toBe(false);
  });
});

// ── Streaming parity (T060, T077) ───────────────────────────────────────

describe('gemini Interactions streaming', () => {
  async function streamDone(usage: Record<string, unknown> | undefined) {
    const events = [
      {
        event_type: 'step.start',
        index: 0,
        step: { type: 'model_output', content: [] },
      },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'text', text: 'A rising tone.' },
      },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: { status: 'completed', ...(usage ? { usage } : {}) },
      },
    ];
    mockFetch(sseResponse(events.map((event) => `data: ${JSON.stringify(event)}`)));
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    const chunks = [];
    for await (const chunk of provider.stream([{ role: 'user', content: AUDIO_INPUT as never }], {
      model: SPLIT_MODEL,
    })) {
      chunks.push(chunk);
    }
    // The stream really did stream: a done-only chunk list would make the
    // parity assertions below vacuous.
    expect(chunks.some((chunk) => chunk.type === 'text_delta')).toBe(true);
    const done = chunks.find((chunk) => chunk.type === 'done');
    if (done?.type !== 'done') throw new Error('no done chunk');
    return done;
  }

  it('T060/T077: the streamed cost and audio fields match the non-streaming path', async () => {
    const done = await streamDone(interactionUsage());
    const nonStreaming = await askAudio(interactionUsage());
    expect(done.cost).toBeCloseTo(GA1_EXPECTED, 14);
    expect(done.cost).toBe(nonStreaming.cost);
    expect(done.usage?.audio_input_tokens).toBe(GA1.audio);
    expect(done.usage).toEqual(nonStreaming.usage);
  });

  it('a stream reporting no usage is unpriced', async () => {
    const done = await streamDone(undefined);
    expect(done.cost).toBeUndefined();
    expect(done.usage).toBeUndefined();
  });

  it('a streamed non-text reply part is unpriced', async () => {
    const events = [
      {
        event_type: 'step.start',
        index: 0,
        step: { type: 'model_output', content: [{ type: 'audio', data: SENTINEL }] },
      },
      { event_type: 'step.stop', index: 0 },
      {
        event_type: 'interaction.completed',
        interaction: { status: 'completed', usage: interactionUsage() },
      },
    ];
    mockFetch(sseResponse(events.map((event) => `data: ${JSON.stringify(event)}`)));
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    let cost: number | undefined = 1;
    for await (const chunk of provider.stream([{ role: 'user', content: AUDIO_INPUT as never }], {
      model: SPLIT_MODEL,
    })) {
      if (chunk.type === 'done') cost = chunk.cost;
    }
    expect(cost).toBeUndefined();
  });
});

// ── Legacy generateContent regression fence (T061) ───────────────────────

describe('gemini text pricing is untouched', () => {
  it('T061: a string-only ask still prices through generateContent, unchanged', async () => {
    mockFetch(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'Sunny.' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 8,
          totalTokenCount: 128,
          serviceTier: 'SERVICE_TIER_STANDARD',
        },
      }),
    );
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    const response = await provider.chat([{ role: 'user', content: 'Weather?' }], {
      model: SPLIT_MODEL,
    });
    // The golden pre-feature number: 120 input + 8 output at 2.5-Flash rates.
    expect(response.cost).toBeCloseTo(
      120 * RATES[SPLIT_MODEL].input + 8 * RATES[SPLIT_MODEL].output,
      14,
    );
    expect('audio_input_tokens' in (response.usage ?? {})).toBe(false);
  });
});

// ── Budget rail (T082-shaped) ───────────────────────────────────────────

describe('gemini audio budget enforcement', () => {
  it('a cost budget enforces on priced Gemini audio asks', async () => {
    const fetchMock = mockFetch(
      interactionReply(interactionUsage()),
      interactionReply(interactionUsage()),
      interactionReply(interactionUsage()),
      interactionReply(interactionUsage()),
    );
    const runtime = googleRuntime();
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const completed: number[] = [];
    runtime.register(
      workflow({
        name: 'gemini-audio-budget',
        input: z.object({}),
        handler: (ctx) =>
          // One ask costs GA1_EXPECTED; the cap admits exactly one.
          ctx.budget({ cost: `$${(GA1_EXPECTED * 1.5).toFixed(9)}` }, async () => {
            for (let turn = 0; turn < 3; turn++) {
              await ctx.ask(
                agent({ model: `google:${SPLIT_MODEL}`, system: 'Listen.' }),
                AUDIO_INPUT as never,
              );
              completed.push(turn);
            }
            return 'never';
          }),
      }),
    );

    const result = (await runtime.execute('gemini-audio-budget', {})) as {
      budgetExceeded: boolean;
      unpriced: boolean;
      totalCost: number;
    };
    expect(result.budgetExceeded).toBe(true);
    expect(result.unpriced).toBe(false);
    // `finish_and_stop` lets the in-flight ask complete and refuses the next.
    expect(completed.length).toBeLessThan(3);
    expect(fetchMock.mock.calls.length).toBeLessThan(3);
    expect(result.totalCost).toBeCloseTo(GA1_EXPECTED * completed.length, 12);
    for (const callEnd of events.filter((event) => event.type === 'agent_call_end')) {
      expect(isUnpricedLeaf(callEnd)).toBe(false);
    }
    await runtime.shutdown();
  });
});
