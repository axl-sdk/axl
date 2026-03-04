import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { llmScorer } from '../llm-scorer.js';

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

  it('throws when no provider is injected', async () => {
    const s = llmScorer(defaultConfig);

    await expect(s.score('output', 'input')).rejects.toThrow(
      'LLM scorer "quality" requires a provider',
    );
  });

  it('scores correctly when provider is injected', async () => {
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

    (s as any)._provider = mockProvider;

    const score = await s.score('output', 'input');
    expect(score).toBe(0.85);
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

    (s as any)._provider = mockProvider;

    await s.score('test output', { question: 'test input' });

    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toBe('You are a quality evaluator.');
    expect(capturedMessages[1].role).toBe('user');
    expect(capturedMessages[1].content).toContain('test output');
    expect(capturedMessages[1].content).toContain('test input');
    // model should strip the provider prefix
    expect(capturedOptions.model).toBe('gpt-4o');
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

    (s as any)._provider = mockProvider;
    await s.score('output', 'input');

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

    (s as any)._provider = mockProvider;
    await s.score('output', 'input');

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

    (s as any)._provider = mockProvider;
    await s.score('output', 'input');

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

    (s as any)._provider = mockProvider;
    await s.score('output', 'input');

    expect(capturedOptions.temperature).toBe(0.8);
  });

  it('validates provider response against schema', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        // Missing required 'reasoning' field
        return { content: JSON.stringify({ score: 0.5 }) };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    (s as any)._provider = mockProvider;

    await expect(s.score('output', 'input')).rejects.toThrow();
  });

  it('throws when provider returns invalid JSON', async () => {
    const mockProvider = {
      async chat(_messages: any[], _options: any) {
        return { content: 'not valid json' };
      },
    };

    const s = llmScorer({
      name: 'test',
      description: 'test',
      model: 'test:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    (s as any)._provider = mockProvider;

    await expect(s.score('output', 'input')).rejects.toThrow();
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

    (s as any)._provider = mockProvider;
    await s.score('output', 'input', { expectedAnswer: '42' });

    const userMessage = capturedMessages[1].content;
    expect(userMessage).toContain('Annotations');
    expect(userMessage).toContain('expectedAnswer');
    expect(userMessage).toContain('42');
  });
});
