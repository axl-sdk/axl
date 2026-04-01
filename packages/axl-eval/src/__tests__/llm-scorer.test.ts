import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { llmScorer } from '../llm-scorer.js';
import type { ScorerContext, ScorerResult } from '../scorer.js';

/** Helper to create a ScorerContext that returns the given mock provider. */
function mockContext(mockProvider: {
  chat: (...args: any[]) => Promise<{ content: string; cost?: number }>;
}): ScorerContext {
  return {
    resolveProvider: (uri: string) => ({
      provider: mockProvider,
      model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
    }),
  };
}

describe('llmScorer()', () => {
  const defaultConfig = {
    name: 'quality',
    description: 'Quality scorer',
    model: 'openai:gpt-4',
    system: 'Rate the quality of the output.',
    schema: z.object({ score: z.number(), reasoning: z.string() }),
  };

  it('creates a scorer with isLlm = true', () => {
    const s = llmScorer(defaultConfig);

    expect(s.name).toBe('quality');
    expect(s.description).toBe('Quality scorer');
    expect(s.isLlm).toBe(true);
  });

  it('throws when no context is provided', async () => {
    const s = llmScorer(defaultConfig);

    await expect(s.score('output', 'input')).rejects.toThrow(
      'LLM scorer "quality" has no provider. Ensure you are running via runEval() with a real AxlRuntime instance.',
    );
  });

  it('propagates error when resolver throws', async () => {
    const s = llmScorer(defaultConfig);
    const ctx: ScorerContext = {
      resolveProvider: () => {
        throw new Error('Unknown provider "openai"');
      },
    };

    await expect(s.score('output', 'input', undefined, ctx)).rejects.toThrow('Unknown provider');
  });

  it('scores correctly when context is provided', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return { content: JSON.stringify({ score: 0.85, reasoning: 'Good output' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.85);
    expect(result.metadata).toEqual({ reasoning: 'Good output' });
    expect(result.cost).toBeUndefined();
  });

  it('passes system message and formatted prompt to provider', async () => {
    let capturedMessages: any[] = [];
    let capturedOptions: any = {};

    const mockProvider = {
      async chat(messages: any[], options: any) {
        capturedMessages = messages;
        capturedOptions = options;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'openai:gpt-4o',
      system: 'You are a quality evaluator.',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score('test output', { question: 'test input' }, undefined, mockContext(mockProvider));

    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toBe('You are a quality evaluator.');
    expect(capturedMessages[1].role).toBe('user');
    expect(capturedMessages[1].content).toContain('test output');
    expect(capturedMessages[1].content).toContain('test input');
    // model should be stripped by the resolver
    expect(capturedOptions.model).toBe('gpt-4o');
    // should request JSON mode for reliable parsing
    expect(capturedOptions.responseFormat).toEqual({ type: 'json_object' });
  });

  it('uses default schema when none provided', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return { content: JSON.stringify({ score: 0.85, reasoning: 'Good' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.85);
    expect(result.metadata).toEqual({ reasoning: 'Good' });
  });

  it('rejects response missing score with default schema — readable error message', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return { content: JSON.stringify({ reasoning: 'ok' }) };
      },
    };

    const s = llmScorer({
      name: 'my-scorer',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });

    await expect(s.score('output', 'input', undefined, mockContext(mockProvider))).rejects.toThrow(
      'LLM scorer "my-scorer" returned an invalid response: score:',
    );
  });

  it('includes JSON schema in prompt', async () => {
    let capturedPrompt = '';
    const mockProvider = {
      async chat(messages: any[], _options: any) {
        capturedPrompt = messages[1].content;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedPrompt).toContain('"type": "object"');
    expect(capturedPrompt).toContain('"properties"');
    expect(capturedPrompt).toContain('"score"');
    expect(capturedPrompt).toContain('"reasoning"');
    // Default schema includes 0-1 range constraint
    expect(capturedPrompt).toContain('"minimum": 0');
    expect(capturedPrompt).toContain('"maximum": 1');
  });

  it('includes custom schema fields in prompt', async () => {
    let capturedPrompt = '';
    const mockProvider = {
      async chat(messages: any[], _options: any) {
        capturedPrompt = messages[1].content;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK', confidence: 0.9 }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string(), confidence: z.number() }),
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedPrompt).toContain('"confidence"');
  });

  it('includes Zod .describe() annotations and .min()/.max() constraints in prompt', async () => {
    let capturedPrompt = '';
    const mockProvider = {
      async chat(messages: any[], _options: any) {
        capturedPrompt = messages[1].content;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({
        score: z.number().min(0).max(1).describe('0 = terrible, 1 = perfect'),
        reasoning: z.string().describe('Brief explanation'),
      }),
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedPrompt).toContain('"description": "0 = terrible, 1 = perfect"');
    expect(capturedPrompt).toContain('"minimum": 0');
    expect(capturedPrompt).toContain('"maximum": 1');
    expect(capturedPrompt).toContain('"description": "Brief explanation"');
  });

  it('formats ZodError as a readable message', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Missing required `reasoning` field
        return { content: JSON.stringify({ score: 0.8 }) };
      },
    };

    const s = llmScorer({
      name: 'quality',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });

    await expect(s.score('output', 'input', undefined, mockContext(mockProvider))).rejects.toThrow(
      'LLM scorer "quality" returned an invalid response: reasoning:',
    );
  });

  it('formats ZodError for wrong type as a readable message', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // score is a string, not a number
        return { content: JSON.stringify({ score: '0.8', reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'quality',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });

    await expect(s.score('output', 'input', undefined, mockContext(mockProvider))).rejects.toThrow(
      'LLM scorer "quality" returned an invalid response: score:',
    );
  });

  it('strips provider prefix from model string', async () => {
    let capturedOptions: any = {};

    const mockProvider = {
      async chat(_messages: any[], options: any) {
        capturedOptions = options;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'anthropic:claude-3-opus',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedOptions.model).toBe('claude-3-opus');
  });

  it('uses model as-is when no provider prefix present', async () => {
    let capturedOptions: any = {};

    const mockProvider = {
      async chat(_messages: any[], options: any) {
        capturedOptions = options;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'gpt-4',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedOptions.model).toBe('gpt-4');
  });

  it('uses default temperature of 0.2', async () => {
    let capturedOptions: any = {};

    const mockProvider = {
      async chat(_messages: any[], options: any) {
        capturedOptions = options;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedOptions.temperature).toBe(0.2);
  });

  it('uses custom temperature when provided', async () => {
    let capturedOptions: any = {};

    const mockProvider = {
      async chat(_messages: any[], options: any) {
        capturedOptions = options;
        return { content: JSON.stringify({ score: 0.5, reasoning: 'OK' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
      temperature: 0.8,
    });

    await s.score('output', 'input', undefined, mockContext(mockProvider));

    expect(capturedOptions.temperature).toBe(0.8);
  });

  it('validates provider response against explicit schema — readable error message', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Missing required 'reasoning' field
        return { content: JSON.stringify({ score: 0.5 }) };
      },
    };

    const s = llmScorer({
      name: 'explicit-schema-scorer',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await expect(s.score('output', 'input', undefined, mockContext(mockProvider))).rejects.toThrow(
      'LLM scorer "explicit-schema-scorer" returned an invalid response: reasoning:',
    );
  });

  it('throws when provider returns invalid JSON', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return { content: 'not valid json at all' };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await expect(
      s.score('output', 'input', undefined, mockContext(mockProvider)),
    ).rejects.toThrow();
  });

  it('extracts JSON from markdown fenced code blocks', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return {
          content: '```json\n{"score": 0.75, "reasoning": "Decent"}\n```',
        };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.75);
  });

  it('extracts JSON when wrapped in leading/trailing text', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return {
          content: 'Here is my evaluation:\n{"score": 0.6, "reasoning": "OK"}\nHope this helps!',
        };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.6);
  });

  it('handles JSON with trailing text after closing brace', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Some models return JSON followed by an explanation
        return {
          content: '{"score": 0.7, "reasoning": "Good"}\n\nI hope this helps!',
        };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.7);
  });

  it('handles non-json fenced code blocks gracefully', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Model wraps in a non-json fence — extractJson should still find the JSON inside
        return {
          content: '```\n{"score": 0.65, "reasoning": "Decent"}\n```',
        };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.65);
  });

  it('handles JSON with nested braces in string values', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Reasoning field contains braces — should not confuse the parser
        return {
          content:
            'My analysis: {"score": 0.5, "reasoning": "The output uses {template} syntax which is incorrect"}',
        };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await s.score(
      'output',
      'input',
      undefined,
      mockContext(mockProvider),
    )) as ScorerResult;
    expect(result.score).toBe(0.5);
  });

  it('passes annotations to LLM scorer so the judge has ground truth', async () => {
    let capturedPrompt = '';
    const mockProvider = {
      async chat(messages: any[], _options: any) {
        capturedPrompt = messages[1].content;
        return { content: JSON.stringify({ score: 1.0, reasoning: 'Matches ground truth' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score(
      'The capital of France is Paris',
      'What is the capital of France?',
      { expectedAnswer: 'Paris' },
      mockContext(mockProvider),
    );

    // The LLM judge should see the ground truth annotations to compare against
    expect(capturedPrompt).toContain('Ground Truth');
    expect(capturedPrompt).toContain('Paris');
    expect(capturedPrompt).toContain('capital of France');
  });

  it('attaches cost to error on JSON parse failure', async () => {
    const mockProvider = {
      async chat() {
        return { content: 'not valid json at all', cost: 0.003 };
      },
    };
    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });
    try {
      await s.score('output', 'input', undefined, mockContext(mockProvider));
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect((err as Record<string, unknown>).cost).toBe(0.003);
    }
  });

  it('attaches cost to error on Zod validation failure', async () => {
    const mockProvider = {
      async chat() {
        return { content: JSON.stringify({ reasoning: 'ok' }), cost: 0.004 }; // missing score
      },
    };
    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
    });
    try {
      await s.score('output', 'input', undefined, mockContext(mockProvider));
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect((err as Record<string, unknown>).cost).toBe(0.004);
    }
  });

  it('includes annotations in prompt when provided', async () => {
    let capturedMessages: any[] = [];

    const mockProvider = {
      async chat(messages: any[], _options: any) {
        capturedMessages = messages;
        return { content: JSON.stringify({ score: 1.0, reasoning: 'Perfect' }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    await s.score('output', 'input', { expectedAnswer: '42' }, mockContext(mockProvider));

    const userMessage = capturedMessages[1].content;
    expect(userMessage).toContain('Annotations');
    expect(userMessage).toContain('expectedAnswer');
    expect(userMessage).toContain('42');
  });
});
