import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { InvalidModelInputError, UnsupportedModelInputError } from '../errors.js';
import {
  describeModelInput,
  normalizeModelInput,
  summarizeModelInput,
  type InputAudioPart,
  type InputContentPart,
  type ModelInput,
} from '../input.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { GROQ_PROFILE } from '../providers/profiles/groq.js';
import { ProviderRegistry } from '../providers/registry.js';
import type {
  InputModalitySupport,
  Provider,
  ProviderInputValidationRequest,
  ProviderResponse,
  StreamChunk,
} from '../providers/types.js';
import { redactEvent, REDACTED } from '../redaction.js';
import type { AxlEvent, ChatMessage } from '../types.js';

const MIB = 1024 * 1024;

const audioBytes = (bytes: number) =>
  ({
    type: 'audio',
    source: { type: 'bytes', data: new Uint8Array(bytes), mediaType: 'audio/wav' },
  }) as const;

const imageBytes = (bytes: number) =>
  ({
    type: 'image',
    source: { type: 'bytes', data: new Uint8Array(bytes), mediaType: 'image/png' },
  }) as const;

const audioInput = [
  { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' } },
  { type: 'text', text: 'Describe this sound.' },
] as const satisfies Exclude<ModelInput, string>;

const imageInput = [
  { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
  { type: 'text', text: 'Describe this picture.' },
] as const satisfies Exclude<ModelInput, string>;

/**
 * A provider that predates audio: it validates input but declares no
 * `inputCapabilities` at all. This is the shape of the in-repo `InputProvider`
 * double in `model-input.test.ts`, whose image tests must keep passing.
 */
class LegacyValidatingProvider implements Provider {
  readonly name = 'legacy';
  chatCalls = 0;
  validations = 0;

  validateInput(request: ProviderInputValidationRequest): { effectiveModel: string } {
    this.validations++;
    return { effectiveModel: `${request.model}-effective` };
  }

  async chat(): Promise<ProviderResponse> {
    this.chatCalls++;
    return { content: 'never', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
}

/** A provider whose declared modality support is under the test's control. */
class CapabilityProvider extends LegacyValidatingProvider {
  constructor(private readonly capabilities: InputModalitySupport) {
    super();
  }

  inputCapabilities(): InputModalitySupport {
    return this.capabilities;
  }
}

function contextFor(
  providerName: string,
  provider: Provider,
  init: Partial<WorkflowContextInit> = {},
  traces: AxlEvent[] = [],
): WorkflowContext {
  const registry = new ProviderRegistry();
  registry.registerInstance(providerName, provider);
  return new WorkflowContext({
    input: 'test',
    executionId: 'model-input-audio-test',
    config: {},
    providerRegistry: registry,
    onTrace: (event) => traces.push(event),
    ...init,
  });
}

const originalFetch = globalThis.fetch;

/** Any provider request at all fails the J6 contract, so the mock throws. */
function forbidFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => {
    throw new Error('provider request issued for an unsupported audio input');
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('normalizeModelInput — audio parts (J1/J2)', () => {
  it('accepts bytes, base64 and provider-file audio and takes an independent copy of bytes', () => {
    const data = new Uint8Array([1, 2, 3]);
    const normalized = normalizeModelInput([
      { type: 'audio', label: 'call', source: { type: 'bytes', data, mediaType: 'audio/wav' } },
      { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/mpeg' } },
      {
        type: 'audio',
        source: { type: 'provider-file', provider: 'google', reference: 'files/abc' },
      },
      { type: 'text', text: 'What is this sound?' },
    ]) as readonly InputContentPart[];

    // Caller mutation after normalization must not reach the retained copy.
    data[0] = 99;

    expect(normalized).toEqual([
      {
        type: 'audio',
        label: 'call',
        source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
      },
      { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/mpeg' } },
      {
        type: 'audio',
        source: { type: 'provider-file', provider: 'google', reference: 'files/abc' },
      },
      { type: 'text', text: 'What is this sound?' },
    ]);
  });

  it('shares one 25 MiB inline budget across images and audio', () => {
    expect(() => normalizeModelInput([imageBytes(20 * MIB)])).not.toThrow();
    expect(() => normalizeModelInput([audioBytes(6 * MIB)])).not.toThrow();
    expect(() => normalizeModelInput([imageBytes(20 * MIB), audioBytes(6 * MIB)])).toThrow(
      InvalidModelInputError,
    );
    expect(() => normalizeModelInput([imageBytes(20 * MIB), audioBytes(6 * MIB)])).toThrow(
      'Inline media data must not exceed 25 MiB total',
    );
  });

  it('rejects url audio, unknown audio source types, and malformed audio payloads', () => {
    expect(() =>
      normalizeModelInput([
        { type: 'audio', source: { type: 'url', url: 'https://example.test/a.wav' } },
      ] as never),
    ).toThrow('part 0.source.type is unsupported');
    expect(() =>
      normalizeModelInput([
        { type: 'text', text: 'x' },
        { type: 'audio', source: { type: 'stream', handle: 1 } },
      ] as never),
    ).toThrow('part 1.source.type is unsupported');
    expect(() =>
      normalizeModelInput([
        { type: 'audio', source: { type: 'base64', data: 'not base64', mediaType: 'audio/wav' } },
      ] as never),
    ).toThrow('part 0.source.data must be valid base64');
    expect(() =>
      normalizeModelInput([
        { type: 'audio', source: { type: 'bytes', data: new Uint8Array(0) } },
      ] as never),
    ).toThrow('part 0.source.data must be a non-empty Uint8Array');
    expect(() =>
      normalizeModelInput([
        { type: 'audio', source: { type: 'bytes', data: new Uint8Array([1]) } },
      ] as never),
    ).toThrow('part 0.source.mediaType must be a non-empty string');
    expect(() =>
      normalizeModelInput([
        { type: 'audio', source: { type: 'provider-file', provider: 'google', reference: '' } },
      ] as never),
    ).toThrow('part 0.source.reference must be a non-empty string');
  });

  it('names audio in the unsupported-part-type error and still rejects an empty input', () => {
    expect(() =>
      normalizeModelInput([{ type: 'video', source: { type: 'base64', data: 'AQID' } }] as never),
    ).toThrow("part 0.type must be 'text', 'image', or 'audio'");
    expect(() => normalizeModelInput([])).toThrow(InvalidModelInputError);
  });
});

describe('audio fails closed without a declared provider capability (J6)', () => {
  it('rejects audio on a provider that validates input but declares no capabilities', async () => {
    const provider = new LegacyValidatingProvider();
    const fetchMock = forbidFetch();
    const error = await contextFor('legacy', provider)
      .ask(agent({ model: 'legacy:any', system: 'listen' }), audioInput)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect((error as UnsupportedModelInputError).source).toBe('base64');
    expect((error as Error).message).not.toContain('image');
    expect(provider.validations).toBe(0);
    expect(provider.chatCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects audio on a provider that declares image support only', async () => {
    const provider = new CapabilityProvider({ image: { sources: ['bytes', 'base64'] } });
    const fetchMock = forbidFetch();
    const error = await contextFor('capability', provider)
      .ask(agent({ model: 'capability:any', system: 'listen' }), audioInput)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect((error as Error).message).not.toContain('image');
    expect(provider.validations).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits audio once the provider declares it, reaching validateInput and dispatch', async () => {
    const provider = new CapabilityProvider({ audio: { sources: ['base64'] } });
    await contextFor('capability', provider).ask(
      agent({ model: 'capability:any', system: 'listen' }),
      audioInput,
    );
    expect(provider.validations).toBe(1);
    expect(provider.chatCalls).toBe(1);
  });

  const shippedAdapters: Array<[string, () => Provider, string]> = [
    ['anthropic', () => new AnthropicProvider({ apiKey: 'test-key' }), 'claude-test'],
    ['openai-responses', () => new OpenAIResponsesProvider({ apiKey: 'test-key' }), 'gpt-test'],
    ['google', () => new GeminiProvider({ apiKey: 'test-key' }), 'gemini-test'],
    // `openai:` and `openrouter:` declare audio as of Phase 2a; their positive
    // and negative audio behavior lives in `compatible-engine-audio.test.ts`.
    // `groq` stays here as the compatible-engine profile that declares NO audio
    // — proof the gate is profile-driven, not engine-wide.
    [
      'groq',
      () => new OpenAICompatibleProvider({ profile: GROQ_PROFILE, apiKey: 'test-key' }),
      'llama-test',
    ],
  ];

  it.each(shippedAdapters)(
    'rejects audio on %s with modality audio and zero requests',
    async (name, make, model) => {
      const fetchMock = forbidFetch();
      const error = await contextFor(name, make())
        .ask(agent({ model: `${name}:${model}`, system: 'listen' }), audioInput)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnsupportedModelInputError);
      expect((error as UnsupportedModelInputError).modality).toBe('audio');
      expect((error as Error).message).not.toContain('image');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized audio history before the summary provider is ever called', async () => {
    const provider = new CapabilityProvider({ image: { sources: ['base64'] } });
    const fetchMock = forbidFetch();
    const traces: AxlEvent[] = [];
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' } },
          { type: 'text', text: 'x'.repeat(4000) },
        ],
      },
    ];
    const error = await contextFor('capability', provider, { sessionHistory: history }, traces)
      .ask(agent({ model: 'capability:any', system: 'listen', maxContext: 1 }), 'text only')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect(provider.validations).toBe(0);
    expect(provider.chatCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(traces.filter((event) => event.type === 'agent_call_start')).toHaveLength(0);
  });
});

describe('image-only rejections keep reporting the image modality (R-A3)', () => {
  const imageRejectors: Array<[string, () => Provider, string]> = [
    ['openai', () => new OpenAIProvider({ apiKey: 'test-key' }), 'gpt-test'],
    [
      'groq',
      () => new OpenAICompatibleProvider({ profile: GROQ_PROFILE, apiKey: 'test-key' }),
      'llama-test',
    ],
  ];

  it.each(imageRejectors)('reports modality image on %s', async (name, make, model) => {
    const fetchMock = forbidFetch();
    const error = await contextFor(name, make())
      .ask(agent({ model: `${name}:${model}`, system: 'look' }), imageInput)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('image');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the image feature and source fields on a raw-container override', async () => {
    const provider = new CapabilityProvider({ image: { sources: ['base64'] } });
    const error = await contextFor('capability', provider)
      .ask(agent({ model: 'capability:any', system: 'look' }), imageInput, {
        providerOptions: { messages: [] },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('image');
    expect((error as Error).message).toContain('raw input-container providerOptions');
  });

  it('rejects an image-only input on a provider without validateInput as image', async () => {
    const provider: Provider = {
      name: 'text-only',
      chat: async () => ({ content: 'never' }),
      stream: async function* () {
        yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      },
    };
    const error = await contextFor('text-only', provider)
      .ask(agent({ model: 'text-only:any', system: 'look' }), imageInput)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('image');
    expect((error as UnsupportedModelInputError).source).toBe('base64');
  });
});

describe('audio observability projections (J7 core)', () => {
  it('describes inline audio structurally and never as an image', () => {
    const descriptor = describeModelInput([
      {
        type: 'audio',
        label: 'call recording',
        source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' },
      },
    ])!;
    expect(descriptor.parts).toEqual([
      {
        type: 'audio',
        source: 'base64',
        mediaType: 'audio/wav',
        bytes: 3,
        label: 'call recording',
      },
    ]);
    expect(JSON.stringify(descriptor)).not.toContain('image');
  });

  it('exposes a provider-file audio reference as a locator only', () => {
    const descriptor = describeModelInput([
      {
        type: 'audio',
        source: {
          type: 'provider-file',
          provider: 'google',
          reference: 'files/call-1',
          mediaType: 'audio/mpeg',
        },
      },
    ])!;
    expect(descriptor.parts).toEqual([
      {
        type: 'audio',
        source: 'provider-file',
        mediaType: 'audio/mpeg',
        locator: 'files/call-1',
      },
    ]);
  });

  it('summarizes audio with its media type and without any image label', () => {
    const summary = summarizeModelInput([
      { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' } },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(summary).toBe('[audio audio/wav]\nwhat is this?');
    expect(summary).not.toContain('image');

    expect(
      summarizeModelInput([
        {
          type: 'audio',
          source: { type: 'provider-file', provider: 'google', reference: 'files/x' },
        },
      ]),
    ).toBe('[audio media]');
  });

  it('redacts the locator and label of an audio descriptor in full traces', async () => {
    const provider = new CapabilityProvider({ audio: { sources: ['provider-file'] } });
    const traces: AxlEvent[] = [];
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'audio',
            label: 'private label',
            source: {
              type: 'provider-file',
              provider: 'capability',
              reference: 'files/private-call',
              mediaType: 'audio/wav',
            },
          },
        ],
      },
    ];
    await contextFor(
      'capability',
      provider,
      { config: { trace: { level: 'full' } }, sessionHistory: history },
      traces,
    ).ask(agent({ model: 'capability:any', system: 'listen' }), 'continue');

    const start = traces.find((event) => event.type === 'agent_call_start')!;
    expect(start.data.messageInputs).toEqual([
      expect.objectContaining({
        index: 1,
        input: expect.objectContaining({
          parts: [
            expect.objectContaining({
              type: 'audio',
              locator: 'files/private-call',
              label: 'private label',
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(start.data.messages)).not.toContain('files/private-call');

    const redacted = redactEvent(start);
    const part = redacted.data.messageInputs?.[0].input.parts[0] as {
      type?: string;
      locator?: string;
      label?: string;
    };
    expect(part.type).toBe('audio');
    expect(part.locator).toBe(REDACTED);
    expect(part.label).toBe(REDACTED);
  });
});

class RecordingAudioProvider extends CapabilityProvider {
  readonly sent: ChatMessage[][] = [];

  constructor() {
    super({ audio: { sources: ['base64'] } });
  }

  override async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
    this.sent.push(messages);
    return { content: 'ok' };
  }
}

describe('audio parts survive the ordered-input contract (J2)', () => {
  it('keeps the audio part at its caller-supplied ordinal through dispatch', async () => {
    const provider = new RecordingAudioProvider();
    await contextFor('capability', provider).ask(
      agent({ model: 'capability:any', system: 'listen' }),
      audioInput,
    );

    const content = provider.sent[0].at(-1)?.content as readonly InputContentPart[];
    expect(content).toEqual([...audioInput]);
    expect((content[0] as InputAudioPart).type).toBe('audio');
  });
});
