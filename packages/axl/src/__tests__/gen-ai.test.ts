import { describe, expect, it } from 'vitest';
import {
  GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES,
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
      options: { ...options, stop: ['x'.repeat(GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES)] },
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
      messages: [{ role: 'user', content: '😀'.repeat(GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES / 2) }],
    }).attributes;
    expect(start).not.toHaveProperty('gen_ai.input.messages');
    expect(JSON.parse(start['gen_ai.tool.definitions'] as string)).toHaveLength(1);
    const end = genAiInferenceEnd({
      captureContent: true,
      response: { content: 'x'.repeat(GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) },
    });
    expect(end).not.toHaveProperty('gen_ai.output.messages');
  });
});
