import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { UnsupportedModelInputError } from '../errors.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { AxlEvent } from '../types.js';
import { tool } from '../tool.js';

// ---------------------------------------------------------------------------
// Multimodal live lighthouse. This file is intentionally double-gated: a key
// alone never spends. Run one named L-row at a time with the direct Vitest
// command documented in docs/testing.md.
// The current allowlists are exercised exactly; an available key is not hidden
// behind a fallback model.
// ---------------------------------------------------------------------------

function liveEnabled(env: Record<string, string | undefined>): boolean {
  return env.AXL_MULTIMODAL_LIVE === '1' && env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
}

const RUN = liveEnabled(process.env);
const PNG_BYTES = readFileSync(
  new URL('../../../../docs/assets/studio-playground.png', import.meta.url),
);
const PNG_BASE64 = PNG_BYTES.toString('base64');
const PNG_BASE64_SENTINEL = PNG_BASE64.slice(0, 128);
const HTTPS_IMAGE =
  'https://raw.githubusercontent.com/axl-sdk/axl/main/docs/assets/studio-playground.png';

async function uploadTemporaryAnthropicImage(): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const body = new FormData();
  body.set('file', new Blob([Uint8Array.from(PNG_BYTES)], { type: 'image/png' }), 'lighthouse.png');
  body.set('expires_in_seconds', '3600');
  const response = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body,
  });
  if (!response.ok) throw new Error(`Anthropic temporary file upload failed (${response.status})`);
  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Anthropic temporary file upload returned no file ID');
  }
  return result.id;
}

async function deleteTemporaryAnthropicImage(fileId: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const response = await fetch(`https://api.anthropic.com/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Anthropic temporary file deletion failed (${response.status})`);
  }
}

function input(
  source:
    | { type: 'bytes'; data: Uint8Array; mediaType: string }
    | { type: 'base64'; data: string; mediaType: string }
    | { type: 'url'; url: string; mediaType?: string }
    | { type: 'provider-file'; provider: string; reference: string },
) {
  return [
    { type: 'text' as const, text: 'Inspect this image and answer concisely.' },
    { type: 'image' as const, label: 'lighthouse fixture', source },
  ] as const;
}

function liveContext() {
  const events: AxlEvent[] = [];
  const context = new WorkflowContext({
    input: 'lighthouse',
    executionId: `multimodal-${randomUUID()}`,
    config: {},
    providerRegistry: new ProviderRegistry(),
    onTrace: (event) => events.push(event),
  });
  return { context, events };
}

function assertHonestTerminal(events: AxlEvent[]) {
  const end = events.find((event) => event.type === 'ask_end');
  expect(end).toBeDefined();
  if (end?.type === 'ask_end') {
    expect(end.outcome.ok).toBe(true);
    expect(Number.isFinite(end.cost)).toBe(true);
    // Rich input may intentionally be unpriced. A priced zero is never treated
    // as evidence that a provider image request was free.
    expect(end.cost > 0 || end.unpriced === true).toBe(true);
  }
}

function assertNoBase64InEvents(events: AxlEvent[]) {
  expect(JSON.stringify(events)).not.toContain(PNG_BASE64_SENTINEL);
}

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  'multimodal live [L1]: OpenAI Responses gpt-4o-mini',
  () => {
    it('[L1] byte image + text returns text with honest terminal accounting', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'openai-responses:gpt-4o-mini', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'bytes', data: PNG_BYTES, mediaType: 'image/png' }),
        { maxTokens: 32, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  'multimodal live [L2]: OpenAI Responses gpt-4o-mini',
  () => {
    it('[L2] HTTPS image + schema streams normal observable events', async () => {
      const { context, events } = liveContext();
      void context.events; // opt into the provider streaming path before ask
      const a = agent({ model: 'openai-responses:gpt-4o-mini', system: 'Return only JSON.' });
      const result = await context.ask(a, input({ type: 'url', url: HTTPS_IMAGE }), {
        maxTokens: 64,
        temperature: 0,
        schema: z.object({ visible: z.boolean() }),
      });
      context.disposeEvents();
      expect(typeof result.visible).toBe('boolean');
      expect(
        events.some((event) => event.type === 'token' || event.type === 'partial_object'),
      ).toBe(true);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.ANTHROPIC_API_KEY)(
  'multimodal live [L11]: Anthropic claude-sonnet-4-5',
  () => {
    it('[L11] forwards an HTTPS URL as native image input without host retrieval', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'anthropic:claude-sonnet-4-5', system: 'Reply with one word.' });
      const result = await context.ask(a, input({ type: 'url', url: HTTPS_IMAGE }), {
        maxTokens: 32,
        temperature: 0,
      });
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.GOOGLE_API_KEY)(
  'multimodal live [L4]: Gemini Interactions gemini-3.7-flash',
  () => {
    it('[L4] byte image + schema uses the rich Gemini transport', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'google:gemini-3.7-flash', system: 'Return only JSON.' });
      const result = await context.ask(
        a,
        input({ type: 'bytes', data: PNG_BYTES, mediaType: 'image/png' }),
        {
          maxTokens: 256,
          temperature: 0,
          effort: 'none',
          schema: z.object({ visible: z.boolean() }),
        },
      );
      expect(typeof result.visible).toBe('boolean');
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.GOOGLE_API_KEY)(
  'multimodal live [L12]: Gemini Interactions gemini-3.7-flash',
  () => {
    it('[L12] forwards an HTTPS image URL through stateless Interactions', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'google:gemini-3.7-flash', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'url', url: HTTPS_IMAGE, mediaType: 'image/png' }),
        {
          maxTokens: 128,
          temperature: 0,
          effort: 'none',
        },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  'multimodal live [L5] (non-blocking): OpenRouter openai/gpt-4o-mini',
  () => {
    it('[L5] maps a base64 image to image_url and preserves provider-reported cost honesty', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'openrouter:openai/gpt-4o-mini', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'base64', data: PNG_BASE64, mediaType: 'image/png' }),
        { maxTokens: 32, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(
  !RUN ||
    !process.env.ANTHROPIC_API_KEY ||
    (!process.env.ANTHROPIC_IMAGE_FILE_ID && process.env.AXL_ANTHROPIC_TEMP_FILE !== '1'),
)('multimodal live [L3]: Anthropic provider-file continuation', () => {
  it('[L3] retains an explicitly supplied Anthropic file reference through one tool continuation', async () => {
    const temporary = !process.env.ANTHROPIC_IMAGE_FILE_ID;
    const fileId = process.env.ANTHROPIC_IMAGE_FILE_ID ?? (await uploadTemporaryAnthropicImage());
    try {
      const { context, events } = liveContext();
      const confirm = tool({
        name: 'confirm_image',
        description: 'Confirm that the image was inspected.',
        input: z.object({}),
        handler: () => ({ confirmed: true }),
      });
      const a = agent({
        model: 'anthropic:claude-sonnet-4-5',
        system: 'Call confirm_image, then reply with one word.',
        tools: [confirm],
        // One model turn must call the tool; the second must produce the final
        // answer. This is the hard request cap for the provider-file probe.
        maxTurns: 2,
      });
      const result = await context.ask(
        a,
        input({ type: 'provider-file', provider: 'anthropic', reference: fileId }),
        { maxTokens: 64, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      expect(events.filter((event) => event.type === 'agent_call_start')).toHaveLength(2);
      assertHonestTerminal(events);
    } finally {
      if (temporary) await deleteTemporaryAnthropicImage(fileId);
    }
  });
});

describe('multimodal local L6: preflight', () => {
  it('[L6] rejects a known text-only Responses model before any dispatch', () => {
    const provider = new OpenAIResponsesProvider({ apiKey: 'not-used' });
    expect(() =>
      provider.validateInput({
        model: 'gpt-4.1-nano',
        input: input({ type: 'base64', data: PNG_BASE64, mediaType: 'image/png' }),
        history: [],
        stream: false,
        hasTools: false,
        responseMode: 'text',
      }),
    ).toThrow(UnsupportedModelInputError);
  });

  it('the absolute kill switch wins over an armed live flag', () => {
    expect(liveEnabled({ AXL_MULTIMODAL_LIVE: '1', AXL_DISABLE_LIVE_INTEGRATION: '1' })).toBe(
      false,
    );
  });
});
