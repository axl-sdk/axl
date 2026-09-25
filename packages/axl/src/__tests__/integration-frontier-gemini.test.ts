/**
 * Exact Gemini 3.8 Flash live certification (plan L6). A key alone never spends:
 * set AXL_FRONTIER_GEMINI_LIVE=1 as well, and select one [G38-*] row with -t.
 * AXL_DISABLE_LIVE_INTEGRATION=1 always wins. This file makes no paid calls
 * in the default frontier run without that explicit switch.
 *
 * Each row uses at most two small requests (maxTokens <= 256). Evidence logs
 * contain route, model, token counts and cost status, never prompts, media,
 * response text, headers or credentials. Image and audio reuse checked-in
 * fixtures. Run only after explicit approval under the live-API workflow.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TINY_PNG_BASE64 } from './fixtures/rich-input-baselines.js';
import { GeminiProvider } from '../providers/gemini.js';
import type {
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
} from '../providers/types.js';

const MODEL = 'gemini-3.8-flash';
const KEY = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
const RUN =
  !!KEY &&
  process.env.AXL_FRONTIER_GEMINI_LIVE === '1' &&
  process.env.AXL_DISABLE_LIVE_INTEGRATION !== '1';

type CapturedCall = {
  route: 'generateContent' | 'streamGenerateContent' | 'interactions';
  requestedModel: string | undefined;
  reportedModel?: string;
  thinkingLevel?: string;
  hasSchema: boolean;
  toolNames: string[];
  hasToolResult: boolean;
  media: Array<{ type: string; mimeType?: string; hasData: boolean }>;
  rawAudioTokens?: number;
};

function safeCall(url: string, init?: RequestInit): CapturedCall {
  const body = JSON.parse(String(init?.body)) as {
    model?: string;
    contents?: Array<{ parts?: Array<{ functionResponse?: unknown }> }>;
    input?: Array<{ content?: Array<{ type?: string; mime_type?: string; data?: string }> }>;
    tools?: Array<{
      name?: string;
      functionDeclarations?: Array<{ name?: string }>;
    }>;
    generationConfig?: {
      thinkingConfig?: { thinkingLevel?: string };
      responseSchema?: unknown;
    };
    generation_config?: { thinking_level?: string };
    response_format?: { schema?: unknown };
  };
  const route = url.includes('/interactions')
    ? 'interactions'
    : url.includes(':streamGenerateContent')
      ? 'streamGenerateContent'
      : 'generateContent';
  return {
    route,
    requestedModel: body.model ?? /\/models\/([^:]+):/.exec(url)?.[1],
    thinkingLevel:
      body.generationConfig?.thinkingConfig?.thinkingLevel ??
      body.generation_config?.thinking_level,
    hasSchema: !!(body.generationConfig?.responseSchema ?? body.response_format?.schema),
    toolNames: (body.tools ?? []).flatMap((tool) =>
      tool.name ? [tool.name] : (tool.functionDeclarations ?? []).flatMap((fn) => fn.name ?? []),
    ),
    hasToolResult: (body.contents ?? []).some((turn) =>
      (turn.parts ?? []).some((part) => part.functionResponse !== undefined),
    ),
    media: (body.input ?? [])
      .flatMap((turn) => turn.content ?? [])
      .filter((part) => part.type === 'image' || part.type === 'audio')
      .map((part) => ({
        type: part.type!,
        mimeType: part.mime_type,
        hasData: typeof part.data === 'string' && part.data.length > 0,
      })),
  };
}

async function captureCalls<T>(run: (calls: CapturedCall[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const calls: CapturedCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const call = safeCall(url, init);
    calls.push(call);
    const response = await originalFetch(input, init);
    if (response.ok && !url.includes('alt=sse')) {
      const raw = (await response.clone().json()) as {
        model?: unknown;
        modelVersion?: unknown;
        usage?: { input_tokens_by_modality?: Array<{ modality?: unknown; tokens?: unknown }> };
      };
      const reported = raw.model ?? raw.modelVersion;
      if (typeof reported === 'string') call.reportedModel = reported;
      const audio = raw.usage?.input_tokens_by_modality?.find(
        (part) => part.modality === 'audio',
      )?.tokens;
      if (typeof audio === 'number') call.rawAudioTokens = audio;
    }
    return response;
  });
  try {
    return await run(calls);
  } finally {
    spy.mockRestore();
  }
}

function expectUsageAndCost(
  response: Pick<ProviderResponse, 'usage' | 'cost' | 'costProvenance'>,
  cost: 'priced' | 'unpriced' | 'either',
): void {
  expect(response.usage?.prompt_tokens).toBeGreaterThan(0);
  expect(response.usage?.total_tokens).toBeGreaterThan(0);
  if (cost === 'unpriced') {
    expect(response.cost).toBeUndefined();
    expect(response.costProvenance).toBeUndefined();
  } else if (cost === 'priced' || response.cost !== undefined) {
    expect(response.cost).toBeGreaterThan(0);
    expect(response.costProvenance).toBe('price_table_estimate');
  }
}

function evidence(
  row: string,
  calls: CapturedCall[],
  terminal: Pick<ProviderResponse, 'usage' | 'cost' | 'costProvenance'>,
): void {
  console.info(
    `[${row}] ${JSON.stringify({
      calls,
      usage: terminal.usage,
      costStatus: terminal.cost === undefined ? 'unpriced' : 'price_table_estimate',
      cost: terminal.cost,
    })}`,
  );
}

async function doneOf(stream: AsyncGenerator<StreamChunk>): Promise<{
  text: string;
  done: Extract<StreamChunk, { type: 'done' }>;
}> {
  let text = '';
  let done: Extract<StreamChunk, { type: 'done' }> | undefined;
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta') text += chunk.content;
    if (chunk.type === 'done') done = chunk;
  }
  expect(done).toBeDefined();
  return { text, done: done! };
}

describe.skipIf(!RUN)('frontier Gemini 3.8 Flash exact-model live certification', () => {
  const provider = () => new GeminiProvider({ apiKey: KEY! });

  it('[G38-text-schema] GenerateContent JSON and none effort use the low floor', async () => {
    await captureCalls(async (calls) => {
      const gemini = provider();
      expect(gemini.effortResolution({ model: MODEL, effort: 'none' })).toMatchObject({
        requested: 'none',
        effective: 'low',
        clamped: true,
      });
      const response = await gemini.chat(
        [{ role: 'user', content: 'Return JSON with the integer sum of 2 + 2 in field sum.' }],
        {
          model: MODEL,
          maxTokens: 256,
          effort: 'none',
          responseFormat: {
            type: 'json_schema',
            json_schema: {
              name: 'sum',
              schema: {
                type: 'object',
                properties: { sum: { type: 'integer' } },
                required: ['sum'],
              },
            },
          },
        },
      );
      expect(JSON.parse(response.content)).toMatchObject({ sum: 4 });
      expectUsageAndCost(response, 'priced');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        route: 'generateContent',
        requestedModel: MODEL,
        thinkingLevel: 'low',
        hasSchema: true,
      });
      if (calls[0].reportedModel) expect(calls[0].reportedModel).toBe(MODEL);
      evidence('G38-text-schema', calls, response);
    });
  }, 90_000);

  it('[G38-tool] GenerateContent tool continuation preserves the native call', async () => {
    await captureCalls(async (calls) => {
      const gemini = provider();
      const tools: ToolDefinition[] = [
        {
          type: 'function',
          function: {
            name: 'acceptance_probe',
            description: 'Return a fixed color from the test application.',
            parameters: { type: 'object', properties: {} },
          },
        },
      ];
      const question: ChatMessage = {
        role: 'user',
        content: 'Call acceptance_probe now, then report the returned value.',
      };
      const first = await gemini.chat([question], {
        model: MODEL,
        maxTokens: 256,
        effort: 'low',
        tools,
        toolChoice: { type: 'function', function: { name: 'acceptance_probe' } },
      });
      expect(first.tool_calls).toHaveLength(1);
      expect(first.tool_calls![0].function.name).toBe('acceptance_probe');
      expectUsageAndCost(first, 'either');
      const second = await gemini.chat(
        [
          question,
          {
            role: 'assistant',
            content: first.content,
            tool_calls: first.tool_calls,
            providerMetadata: first.providerMetadata,
          },
          { role: 'tool', content: 'green', tool_call_id: first.tool_calls![0].id },
        ],
        { model: MODEL, maxTokens: 128, effort: 'low', tools, toolChoice: 'none' },
      );
      expect(second.content.toLowerCase()).toContain('green');
      expectUsageAndCost(second, 'either');
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.route)).toEqual(['generateContent', 'generateContent']);
      expect(calls.map((call) => call.requestedModel)).toEqual([MODEL, MODEL]);
      expect(calls[0].toolNames).toContain('acceptance_probe');
      expect(calls[1].hasToolResult).toBe(true);
      evidence('G38-tool-first', [calls[0]], first);
      evidence('G38-tool-second', [calls[1]], second);
    });
  }, 120_000);

  it('[G38-stream] GenerateContent SSE has text and terminal metering', async () => {
    await captureCalls(async (calls) => {
      const result = await doneOf(
        provider().stream([{ role: 'user', content: 'Reply with exactly violet.' }], {
          model: MODEL,
          maxTokens: 128,
          effort: 'low',
        }),
      );
      expect(result.text.toLowerCase()).toContain('violet');
      expectUsageAndCost(result.done, 'priced');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        route: 'streamGenerateContent',
        requestedModel: MODEL,
      });
      evidence('G38-stream', calls, result.done);
    });
  }, 90_000);

  it('[G38-image] Interactions accepts the one-pixel image and reports metering', async () => {
    await captureCalls(async (calls) => {
      const response = await provider().chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
              },
              {
                type: 'text',
                text: "Is this a photograph or a tiny blank/pixel image? Reply 'photo' or 'pixel'.",
              },
            ],
          },
        ],
        { model: MODEL, maxTokens: 128, effort: 'low' },
      );
      expect(response.content.toLowerCase()).toContain('pixel');
      expectUsageAndCost(response, 'either');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ route: 'interactions', requestedModel: MODEL });
      expect(calls[0].media).toEqual([{ type: 'image', mimeType: 'image/png', hasData: true }]);
      if (calls[0].reportedModel) expect(calls[0].reportedModel).toBe(MODEL);
      evidence('G38-image', calls, response);
    });
  }, 90_000);

  it('[G38-audio] Interactions reports positive recorded-audio tokens as unpriced', async () => {
    await captureCalls(async (calls) => {
      const audio = readFileSync(
        new URL('./fixtures/recorded-call.mp3.b64', import.meta.url),
        'utf8',
      ).replace(/\s/g, '');
      const response = await provider().chat(
        [
          {
            role: 'user',
            content: [
              { type: 'audio', source: { type: 'base64', data: audio, mediaType: 'audio/mpeg' } },
              {
                type: 'text',
                text: "Is this clip human speech or a pure electronic tone? Reply 'speech' or 'tone'.",
              },
            ],
          },
        ],
        { model: MODEL, maxTokens: 128, effort: 'low' },
      );
      expect(response.content.toLowerCase()).toContain('speech');
      expect(response.usage?.audio_input_tokens).toBeGreaterThan(0);
      expectUsageAndCost(response, 'unpriced');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ route: 'interactions', requestedModel: MODEL });
      expect(calls[0].media).toEqual([{ type: 'audio', mimeType: 'audio/mpeg', hasData: true }]);
      expect(calls[0].rawAudioTokens).toBeGreaterThan(0);
      if (calls[0].reportedModel) expect(calls[0].reportedModel).toBe(MODEL);
      evidence('G38-audio', calls, response);
    });
  }, 120_000);
});
