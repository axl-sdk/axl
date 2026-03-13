import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';

// ---------------------------------------------------------------------------
// providerOptions escape hatch — live API integration tests
//
// Verifies that unmapped API parameters flow through to the wire via
// providerOptions. Tests use two strategies:
//
//   1. Behavioral: parameters that change model output (e.g. verbosity)
//      are tested by comparing responses with different settings.
//
//   2. Validation: parameters that the API validates on receipt (e.g.
//      metadata, safetySettings) prove they reached the wire because
//      the API would error on invalid values or missing prerequisites.
//      We include negative tests to confirm the API rejects bad params.
//
// Uses the cheapest modern models to minimize cost:
//   OpenAI:    gpt-5-nano  ($0.05 / $0.40 per M tokens)
//   Gemini:    gemini-2.5-flash ($0.30 / $2.50) + gemini-3.1-flash-lite-preview ($0.25 / $1.50)
//   Anthropic: claude-haiku-4-5 ($1.00 / $5.00)
// ---------------------------------------------------------------------------

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
const hasGoogle = !!process.env.GOOGLE_API_KEY;

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (gpt-5-nano)
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('providerOptions: OpenAI Chat Completions', () => {
  const model = 'openai:gpt-5-nano';

  // Behavioral test: verbosity controls response length.
  // GPT-5's verbosity param constrains how verbose the model's reply is.
  // 'low' should produce a shorter response than 'high' for the same prompt.
  it('verbosity: low produces shorter output than high', async () => {
    const prompt = 'Explain what the internet is and how it works.';

    const lowAgent = agent({
      model,
      system: 'Answer the question.',
      providerOptions: { verbosity: 'low' },
    });
    const highAgent = agent({
      model,
      system: 'Answer the question.',
      providerOptions: { verbosity: 'high' },
    });

    const [lowResult, highResult] = await Promise.all([
      lowAgent.ask(prompt),
      highAgent.ask(prompt),
    ]);

    expect(typeof lowResult).toBe('string');
    expect(typeof highResult).toBe('string');
    expect(lowResult.length).toBeGreaterThan(0);
    expect(highResult.length).toBeGreaterThan(0);

    // High verbosity should produce a meaningfully longer response
    expect(highResult.length).toBeGreaterThan(lowResult.length);
  }, 30_000);

  // Validation test: metadata requires store:true.
  // The API explicitly rejects metadata without store — proving the param
  // reaches the wire. We test both the rejection and the acceptance.
  it('metadata without store is rejected (proves param reaches wire)', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: { metadata: { test_key: 'test_value' } },
    });

    await expect(a.ask('Say hello')).rejects.toThrow(/metadata.*store/i);
  }, 30_000);

  it('metadata with store:true is accepted', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: { store: true, metadata: { test_key: 'test_value' } },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  it('providerOptions coexists with effort', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      effort: 'low',
      providerOptions: { verbosity: 'low' },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// OpenAI Responses API (gpt-5-nano)
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)('providerOptions: OpenAI Responses API', () => {
  const model = 'openai-responses:gpt-5-nano';

  // Behavioral test: verbosity on Responses API lives under text.verbosity
  // (different from Chat Completions where it's top-level — good test of nesting)
  it('text.verbosity: low produces shorter output than high', async () => {
    const prompt = 'Explain what the internet is and how it works.';

    const lowAgent = agent({
      model,
      system: 'Answer the question.',
      providerOptions: { text: { verbosity: 'low' } },
    });
    const highAgent = agent({
      model,
      system: 'Answer the question.',
      providerOptions: { text: { verbosity: 'high' } },
    });

    const [lowResult, highResult] = await Promise.all([
      lowAgent.ask(prompt),
      highAgent.ask(prompt),
    ]);

    expect(typeof lowResult).toBe('string');
    expect(typeof highResult).toBe('string');
    expect(lowResult.length).toBeGreaterThan(0);
    expect(highResult.length).toBeGreaterThan(0);

    // High verbosity should produce a meaningfully longer response
    expect(highResult.length).toBeGreaterThan(lowResult.length);
  }, 30_000);

  // Validation test: metadata passthrough
  it('passes metadata to the API via providerOptions', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: { metadata: { test_run: 'integration' } },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  it('providerOptions coexists with effort', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      effort: 'low',
      providerOptions: { text: { verbosity: 'low' } },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Anthropic (claude-haiku-4-5)
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnthropic)('providerOptions: Anthropic', () => {
  const model = 'anthropic:claude-haiku-4-5';

  // Validation test: Anthropic validates metadata.user_id format.
  // An invalid user_id type would be rejected, proving the param reaches the wire.
  it('passes metadata to the API via providerOptions', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: { metadata: { user_id: 'integration-test' } },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Gemini 2.x (gemini-2.5-flash) — uses thinkingBudget code path
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('providerOptions: Gemini 2.x', () => {
  const model = 'google:gemini-2.5-flash';

  // Validation test: safetySettings is a top-level Gemini param that the API
  // validates (rejects invalid categories/thresholds). If providerOptions didn't
  // merge it, the API wouldn't see it and default settings would apply.
  it('passes safetySettings via providerOptions (top-level param)', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: {
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_ONLY_HIGH',
          },
        ],
      },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  // Validation test (negative): invalid safety category is rejected
  it('rejects invalid safetySettings category (proves param reaches wire)', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: {
        safetySettings: [
          {
            category: 'INVALID_CATEGORY_DOES_NOT_EXIST',
            threshold: 'BLOCK_ONLY_HIGH',
          },
        ],
      },
    });

    await expect(a.ask('Say hello')).rejects.toThrow();
  }, 30_000);

  it('providerOptions coexists with effort (thinkingBudget path)', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      effort: 'low',
      providerOptions: {
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_ONLY_HIGH',
          },
        ],
      },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Gemini 3.x (gemini-3.1-flash-lite-preview) — uses thinkingLevel code path
// ---------------------------------------------------------------------------

describe.skipIf(!hasGoogle)('providerOptions: Gemini 3.x', () => {
  const model = 'google:gemini-3.1-flash-lite-preview';

  it('passes safetySettings via providerOptions on 3.x model', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      providerOptions: {
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_ONLY_HIGH',
          },
        ],
      },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  it('providerOptions coexists with effort on 3.x (thinkingLevel path)', async () => {
    const a = agent({
      model,
      system: 'Reply with one word only.',
      effort: 'high',
      providerOptions: {
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_ONLY_HIGH',
          },
        ],
      },
    });

    const result = await a.ask('Say hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);
});
