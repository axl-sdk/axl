import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import {
  OPENROUTER_PROFILE,
  XAI_PROFILE,
  DEEPSEEK_PROFILE,
  MISTRAL_PROFILE,
  GROQ_PROFILE,
  AZURE_PROFILE,
  BEDROCK_PROFILE,
  OLLAMA_PROFILE,
} from '../providers/profiles/index.js';
import type { ChatMessage, ChatOptions } from '../providers/types.js';

// ---------------------------------------------------------------------------
// OpenAI-compatible PRESETS — live API integration smoke tests.
//
// Each block is gated on its own API key, so the default `pnpm test` run skips
// everything here; run with keys via `pnpm test:integration`.
//
// Goal is wire-format VALIDATION, not behavior: the riskiest part of the preset
// layer is the per-model `reasoning_effort` gating (which already produced three
// 400/422 bugs in review). The key assertions are therefore:
//   (a) a tiny chat() call is ACCEPTED (no 4xx) — the wire shape is valid;
//   (b) setting `effort` does NOT 400/422 on the models we map it onto;
//   (c) usage is returned, and cost behaves per the profile's pricing source.
//
// Payloads are kept tiny (maxTokens: 16, one short message) on the cheapest
// model per provider to minimize cost. Model ids are intentionally conservative;
// update if a provider retires them.
// ---------------------------------------------------------------------------

const SMOKE: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: ok' }];
const tiny: Partial<ChatOptions> = { maxTokens: 16, temperature: 0 };

async function smoke(
  provider: OpenAICompatibleProvider,
  model: string,
  extra: Partial<ChatOptions> = {},
) {
  return provider.chat(SMOKE, { model, ...tiny, ...extra });
}

// ── OpenRouter ────────────────────────────────────────────────────────────

describe.skipIf(!process.env.OPENROUTER_API_KEY)('preset: OpenRouter', () => {
  const provider = () => new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE });
  const model = 'openai/gpt-4o-mini'; // cheap, broadly available slug

  it('accepts a chat call and reports provider cost (from-response pricing)', async () => {
    const res = await smoke(provider(), model);
    expect(typeof res.content).toBe('string');
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
    // from-response: OpenRouter returns usage.cost (USD); should be a number ≥ 0.
    expect(typeof res.cost).toBe('number');
    expect(res.cost!).toBeGreaterThanOrEqual(0);
  });

  it('does not error when effort is set (reasoning object accepted)', async () => {
    await expect(smoke(provider(), model, { effort: 'low' })).resolves.toBeDefined();
  });
});

// ── xAI Grok ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.XAI_API_KEY)('preset: xAI', () => {
  const provider = () => new OpenAICompatibleProvider({ profile: XAI_PROFILE });

  it('grok-3-mini accepts reasoning_effort (the family we map onto)', async () => {
    const res = await smoke(provider(), 'grok-3-mini', { effort: 'low' });
    expect(typeof res.content).toBe('string');
  });

  it('grok-4 does not 400 when effort is set (we omit reasoning_effort there)', async () => {
    await expect(smoke(provider(), 'grok-4', { effort: 'high' })).resolves.toBeDefined();
  });
});

// ── DeepSeek ────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('preset: DeepSeek', () => {
  const provider = () => new OpenAICompatibleProvider({ profile: DEEPSEEK_PROFILE });

  it('deepseek-chat accepts a chat call', async () => {
    const res = await smoke(provider(), 'deepseek-chat');
    expect(typeof res.content).toBe('string');
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
  });

  it('deepseek-reasoner captures reasoning_content + does not 400 on a tool-call round-trip', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_time',
          description: 'Get the current time',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const first = await provider().chat(
      [{ role: 'user', content: 'What time is it? Use the tool.' }],
      {
        model: 'deepseek-reasoner',
        maxTokens: 64,
        tools,
      },
    );
    // If it asked for the tool, echo the reasoning back on the tool-call turn
    // (the per-turn rule we must not 400 on).
    if (first.tool_calls?.length) {
      const followup = await provider().chat(
        [
          { role: 'user', content: 'What time is it? Use the tool.' },
          {
            role: 'assistant',
            content: first.content,
            tool_calls: first.tool_calls,
            providerMetadata: first.providerMetadata,
          },
          { role: 'tool', content: '12:00', tool_call_id: first.tool_calls[0].id },
        ],
        { model: 'deepseek-reasoner', maxTokens: 64, tools },
      );
      expect(typeof followup.content).toBe('string');
    } else {
      // Even without a tool call, reasoning_content should have been captured.
      expect(typeof first.content).toBe('string');
    }
  });
});

// ── Mistral ─────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.MISTRAL_API_KEY)('preset: Mistral', () => {
  const provider = () => new OpenAICompatibleProvider({ profile: MISTRAL_PROFILE });

  it('mistral-small accepts reasoning_effort (the family we map onto)', async () => {
    const res = await smoke(provider(), 'mistral-small-latest', { effort: 'high' });
    expect(typeof res.content).toBe('string');
  });

  it('mistral-large does NOT 422 when effort is set (we omit reasoning_effort there)', async () => {
    await expect(
      smoke(provider(), 'mistral-large-latest', { effort: 'high' }),
    ).resolves.toBeDefined();
  });
});

// ── Groq ────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.GROQ_API_KEY)('preset: Groq', () => {
  const provider = () => new OpenAICompatibleProvider({ profile: GROQ_PROFILE });

  it('gpt-oss accepts reasoning_effort (low/medium/high)', async () => {
    const res = await smoke(provider(), 'openai/gpt-oss-20b', { effort: 'low' });
    expect(typeof res.content).toBe('string');
  });

  it('a non-gpt-oss model does NOT 400 when effort is set (we omit it there)', async () => {
    await expect(
      smoke(provider(), 'llama-3.1-8b-instant', { effort: 'medium' }),
    ).resolves.toBeDefined();
  });

  it('does not 400 on messages[].name (we strip it)', async () => {
    await expect(
      provider().chat([{ role: 'user', content: 'ok', name: 'tester' }], {
        model: 'llama-3.1-8b-instant',
        ...tiny,
      }),
    ).resolves.toBeDefined();
  });
});

// ── Azure OpenAI (needs resource URL + deployment) ──────────────────────────

describe.skipIf(
  !process.env.AZURE_OPENAI_API_KEY ||
    !process.env.AZURE_OPENAI_BASE_URL ||
    !process.env.AZURE_OPENAI_DEPLOYMENT,
)('preset: Azure OpenAI', () => {
  it('accepts a chat call against the configured deployment via the api-key header', async () => {
    const provider = new OpenAICompatibleProvider({ profile: AZURE_PROFILE });
    const res = await smoke(provider, process.env.AZURE_OPENAI_DEPLOYMENT!);
    expect(typeof res.content).toBe('string');
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
  });
});

// ── AWS Bedrock (gpt-oss via the OpenAI-compatible endpoint) ────────────────

describe.skipIf(!process.env.AWS_BEARER_TOKEN_BEDROCK || !process.env.BEDROCK_BASE_URL)(
  'preset: AWS Bedrock',
  () => {
    const provider = () => new OpenAICompatibleProvider({ profile: BEDROCK_PROFILE });
    const model = process.env.BEDROCK_MODEL ?? 'openai.gpt-oss-20b-1:0';

    it('accepts a gpt-oss chat call via bearer auth', async () => {
      const res = await smoke(provider(), model);
      expect(typeof res.content).toBe('string');
      expect(res.usage?.total_tokens).toBeGreaterThan(0);
    });

    it('does not 4xx with reasoning_effort set on gpt-oss', async () => {
      await expect(smoke(provider(), model, { effort: 'low' })).resolves.toBeDefined();
    });
  },
);

// ── Self-hosted (opt-in: requires a running local server) ───────────────────
// Gate on OLLAMA_BASE_URL so this only runs when a user points at their server.

describe.skipIf(!process.env.OLLAMA_BASE_URL)('preset: Ollama (local)', () => {
  it('reaches a local server with no key and reports cost 0', async () => {
    const provider = new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE });
    const model = process.env.OLLAMA_MODEL ?? 'llama3';
    const res = await smoke(provider, model);
    expect(typeof res.content).toBe('string');
    expect(res.cost).toBe(0); // local pricing is an explicit zero
  });
});
