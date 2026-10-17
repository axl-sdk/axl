import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES,
  GenAiStreamContent,
  genAiInferenceEnd,
  genAiInferenceStart,
} from '../telemetry/gen-ai.js';

const options = {
  model: 'gpt-test',
  temperature: 0,
  maxTokens: 20,
  stop: ['sensitive-stop'],
  effort: 'high' as const,
  providerOptions: { api_key: 'credential-sentinel' },
  responseFormat: { type: 'json_object' as const },
  tools: [
    {
      type: 'function' as const,
      function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } },
    },
  ],
};

describe('pinned GenAI inference mapping', () => {
  it('projects separate native system instructions once and keeps Chat Completions system turns in history', () => {
    const messages = [
      { role: 'system' as const, content: 'first instruction' },
      { role: 'user' as const, content: 'question' },
      { role: 'system' as const, content: 'second instruction' },
    ];
    for (const providerId of ['anthropic', 'google', 'openai-responses']) {
      const attrs = genAiInferenceStart({
        providerId,
        options,
        stream: false,
        captureContent: true,
        messages,
      }).attributes;
      expect(JSON.parse(attrs['gen_ai.system_instructions'] as string)).toEqual([
        { type: 'text', content: 'first instruction' },
        { type: 'text', content: 'second instruction' },
      ]);
      expect(JSON.parse(attrs['gen_ai.input.messages'] as string)).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'question' }] },
      ]);
      expect(attrs['gen_ai.input.messages'] as string).not.toContain('instruction');
    }
    for (const providerId of ['openai', 'xai']) {
      const attrs = genAiInferenceStart({
        providerId,
        options,
        stream: false,
        captureContent: true,
        messages,
      }).attributes;
      expect(attrs).not.toHaveProperty('gen_ai.system_instructions');
      expect(
        JSON.parse(attrs['gen_ai.input.messages'] as string).map((m: { role: string }) => m.role),
      ).toEqual(['system', 'user', 'system']);
    }
  });

  it('redacts and bounds separate system-instruction JSON independently', () => {
    const messages = [
      {
        role: 'system' as const,
        content: '😀'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES / 2),
      },
      { role: 'user' as const, content: 'question' },
    ];
    const capped = genAiInferenceStart({
      providerId: 'anthropic',
      options,
      stream: false,
      captureContent: true,
      messages,
    }).attributes;
    expect(capped).not.toHaveProperty('gen_ai.system_instructions');
    expect(JSON.parse(capped['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'question' }] },
    ]);
    const redacted = genAiInferenceStart({
      providerId: 'anthropic',
      options,
      stream: false,
      captureContent: true,
      redact: true,
      messages: [{ role: 'system', content: 'private instruction' }],
    }).attributes;
    expect(redacted).not.toHaveProperty('gen_ai.system_instructions');
    expect(redacted).not.toHaveProperty('gen_ai.input.messages');
    const unknownRichSystem = genAiInferenceStart({
      providerId: 'google',
      options,
      stream: false,
      captureContent: true,
      messages: [{ role: 'system', content: [{ type: 'text', text: 'rich system' }] }],
    }).attributes;
    expect(unknownRichSystem).not.toHaveProperty('gen_ai.system_instructions');
    expect(JSON.parse(unknownRichSystem['gen_ai.input.messages'] as string)).toEqual([]);
  });

  it('maps structural fields and native array attributes without opaque options', () => {
    const { name, attributes } = genAiInferenceStart({
      providerId: 'openai-responses',
      options,
      stream: true,
      sessionId: 'session-1',
      effectiveReasoningLevel: 'medium',
    });
    expect(name).toBe('chat gpt-test');
    expect(attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.request.stream': true,
      'gen_ai.conversation.id': 'session-1',
      'gen_ai.output.type': 'json',
      'gen_ai.request.temperature': 0,
      'gen_ai.request.max_tokens': 20,
      'gen_ai.request.reasoning.level': 'medium',
      'gen_ai.request.stop_sequences': ['sensitive-stop'],
    });
    expect(attributes['gen_ai.request.stop_sequences']).toEqual(['sensitive-stop']);
    expect(JSON.stringify(attributes)).not.toContain('credential-sentinel');
    const withoutNativeLevel = genAiInferenceStart({
      providerId: 'google',
      options,
      stream: false,
    });
    expect(withoutNativeLevel.attributes['gen_ai.provider.name']).toBe('gcp.gen_ai');
    expect(withoutNativeLevel.attributes).not.toHaveProperty('gen_ai.request.reasoning.level');
    expect(
      genAiInferenceStart({ providerId: 'xai', options, stream: false }).attributes[
        'gen_ai.provider.name'
      ],
    ).toBe('x_ai');
    expect(genAiInferenceEnd({ response: { content: 'answer' } })).not.toHaveProperty(
      'gen_ai.response.time_to_first_chunk',
    );
  });

  it('emits upstream message, tool, and output JSON shapes with no raw metadata', () => {
    const start = genAiInferenceStart({
      providerId: 'anthropic',
      options,
      stream: false,
      captureContent: true,
      messages: [
        { role: 'user', content: 'weather?', providerMetadata: { auth: 'credential-sentinel' } },
        {
          role: 'assistant',
          content: '',
          agent: 'internal-agent',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'rainy' },
      ],
    }).attributes;
    expect(JSON.parse(start['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'weather?' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: '' },
          { type: 'tool_call', id: 'call-1', name: 'weather', arguments: { city: 'Paris' } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', response: 'rainy' }] },
    ]);
    expect(JSON.parse(start['gen_ai.tool.definitions'] as string)).toEqual([
      { type: 'function', name: 'weather', description: 'Weather', parameters: { type: 'object' } },
    ]);
    expect(JSON.stringify(start)).not.toContain('credential-sentinel');
    expect(JSON.stringify(start)).not.toContain('internal-agent');

    const end = genAiInferenceEnd({
      captureContent: true,
      response: {
        content: 'answer',
        thinking_content: 'reasoning',
        finishReason: 'stop',
        responseId: 'id-1',
        responseModel: 'actual',
        usage: {
          prompt_tokens: 9,
          completion_tokens: 5,
          total_tokens: 14,
          cached_tokens: 3,
          cache_write_tokens: 2,
          reasoning_tokens: 1,
        },
      },
      firstChunkMs: 42,
    });
    expect(end['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(end['gen_ai.response.time_to_first_chunk']).toBe(0.042);
    expect(end['gen_ai.usage.cache_read.input_tokens']).toBe(3);
    expect(end['gen_ai.usage.cache_write.input_tokens']).toBe(2);
    expect(end['gen_ai.usage.reasoning.output_tokens']).toBe(1);
    expect(genAiInferenceEnd({ errorType: 'ProviderError' })['error.type']).toBe('ProviderError');
    expect(genAiInferenceEnd({ errorType: 'secret prompt text' })['error.type']).toBe('error');
    expect(JSON.parse(end['gen_ai.output.messages'] as string)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'answer' },
          { type: 'reasoning', content: 'reasoning' },
        ],
      },
    ]);
  });

  it('keeps prompt, stop, and response content out when redacted, even after opt-in', () => {
    const start = genAiInferenceStart({
      providerId: 'openai',
      options,
      stream: false,
      captureContent: true,
      redact: true,
      messages: [{ role: 'user', content: 'sensitive-prompt' }],
    }).attributes;
    expect(start).not.toHaveProperty('gen_ai.input.messages');
    expect(start).not.toHaveProperty('gen_ai.tool.definitions');
    expect(start).not.toHaveProperty('gen_ai.request.stop_sequences');
    expect(start['gen_ai.request.model']).toBe('gpt-test');
    const end = genAiInferenceEnd({
      captureContent: true,
      redact: true,
      response: { content: 'sensitive-answer', finishReason: 'stop' },
    });
    expect(end).not.toHaveProperty('gen_ai.output.messages');
    expect(end['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const hugeStop = genAiInferenceStart({
      providerId: 'openai',
      options: { ...options, stop: ['x'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES)] },
      stream: false,
    }).attributes;
    expect(hugeStop).not.toHaveProperty('gen_ai.request.stop_sequences');
  });

  it('omits oversized attributes whole and keeps emitted content valid JSON', () => {
    const start = genAiInferenceStart({
      providerId: 'openai',
      options,
      stream: false,
      captureContent: true,
      messages: [
        { role: 'user', content: '😀'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES / 2) },
      ],
    }).attributes;
    expect(start).not.toHaveProperty('gen_ai.input.messages');
    expect(JSON.parse(start['gen_ai.tool.definitions'] as string)).toHaveLength(1);
    const end = genAiInferenceEnd({
      captureContent: true,
      response: { content: 'x'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) },
    });
    expect(end).not.toHaveProperty('gen_ai.output.messages');
    const streamed = new GenAiStreamContent();
    streamed.observe({
      type: 'text_delta',
      content: '😀'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES / 2),
    });
    const partial = streamed.snapshot();
    expect(partial.omitContent).toBe(true);
    const streamEnd = genAiInferenceEnd({
      response: { ...partial.response, finishReason: 'stop' },
      omitContent: partial.omitContent,
      captureContent: true,
    });
    expect(streamEnd).not.toHaveProperty('gen_ai.output.messages');
    expect(streamEnd['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('uses a caller-supplied content bound for start, end and streamed output', () => {
    const text = 'x'.repeat(200);
    const start = genAiInferenceStart({
      providerId: 'openai',
      options: { ...options, stop: [text] },
      stream: false,
      captureContent: true,
      maxContentBytes: 100,
      messages: [{ role: 'user', content: text }],
    }).attributes;
    expect(start).not.toHaveProperty('gen_ai.input.messages');
    expect(start).not.toHaveProperty('gen_ai.request.stop_sequences');
    expect(start['axl.gen_ai.content_omitted']).toContain('gen_ai.input.messages');
    expect(
      genAiInferenceEnd({
        captureContent: true,
        maxContentBytes: 100,
        response: { content: text },
      }),
    ).not.toHaveProperty('gen_ai.output.messages');
    const streamed = new GenAiStreamContent(100);
    streamed.observe({ type: 'text_delta', content: text });
    expect(streamed.snapshot().omitContent).toBe(true);
    const roomy = new GenAiStreamContent(1000);
    roomy.observe({ type: 'text_delta', content: text });
    expect(roomy.snapshot()).toEqual({ response: { content: text }, omitContent: false });
  });

  it('names every opted-in content attribute it omitted for size', () => {
    const huge = '😀'.repeat(DEFAULT_GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES / 2);
    const start = genAiInferenceStart({
      providerId: 'anthropic',
      options,
      stream: false,
      captureContent: true,
      messages: [
        { role: 'system', content: huge },
        { role: 'user', content: huge },
      ],
    }).attributes;
    expect(start['axl.gen_ai.content_omitted']).toEqual([
      'gen_ai.input.messages',
      'gen_ai.system_instructions',
    ]);
    expect(
      genAiInferenceEnd({ captureContent: true, response: { content: huge } })[
        'axl.gen_ai.content_omitted'
      ],
    ).toEqual(['gen_ai.output.messages']);
    expect(
      genAiInferenceEnd({ captureContent: true, omitContent: true, response: {} })[
        'axl.gen_ai.content_omitted'
      ],
    ).toEqual(['gen_ai.output.messages']);
    // Nothing was omitted: no marker. Redaction suppresses content, not "omits" it.
    const small = genAiInferenceStart({
      providerId: 'openai',
      options,
      stream: false,
      captureContent: true,
      messages: [{ role: 'user', content: 'hi' }],
    }).attributes;
    expect(small).not.toHaveProperty('axl.gen_ai.content_omitted');
    const redacted = genAiInferenceStart({
      providerId: 'openai',
      options,
      stream: false,
      captureContent: true,
      redact: true,
      messages: [{ role: 'user', content: huge }],
    }).attributes;
    expect(redacted).not.toHaveProperty('axl.gen_ai.content_omitted');
  });
});
