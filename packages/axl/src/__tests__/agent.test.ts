import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';

describe('agent()', () => {
  // ── Creation ────────────────────────────────────────────────────────────

  it('creates agent with a resolved model string', () => {
    const a = agent({
      model: 'openai:gpt-4o',
      system: 'You are helpful.',
    });
    expect(a.resolveModel()).toBe('openai:gpt-4o');
  });

  it('uses model as default _name when no name provided', () => {
    const a = agent({
      model: 'openai:gpt-4o',
      system: 'Test',
    });
    expect(a._name).toBe('openai:gpt-4o');
  });

  it('uses explicit name when provided', () => {
    const a = agent({
      name: 'SupportBot',
      model: 'openai:gpt-4o',
      system: 'Test',
    });
    expect(a._name).toBe('SupportBot');
  });

  // ── resolveModel ─────────────────────────────────────────────────────────

  it('resolveModel returns static string when model is a string', () => {
    const a = agent({
      model: 'anthropic:claude-3',
      system: 'Test',
    });
    expect(a.resolveModel()).toBe('anthropic:claude-3');
    expect(a.resolveModel({ metadata: { tier: 'premium' } })).toBe('anthropic:claude-3');
  });

  it('resolveModel calls function when model is a function, passing ctx', () => {
    const a = agent({
      model: (ctx) => {
        return ctx.metadata?.tier === 'premium' ? 'openai:gpt-4o' : 'openai:gpt-3.5-turbo';
      },
      system: 'Test',
    });

    expect(a.resolveModel({ metadata: { tier: 'premium' } })).toBe('openai:gpt-4o');
    expect(a.resolveModel({ metadata: { tier: 'basic' } })).toBe('openai:gpt-3.5-turbo');
    expect(a.resolveModel()).toBe('openai:gpt-3.5-turbo');
  });

  // ── resolveSystem ────────────────────────────────────────────────────────

  it('resolveSystem returns static string when system is a string', () => {
    const a = agent({
      model: 'openai:gpt-4o',
      system: 'You are a helpful assistant.',
    });
    expect(a.resolveSystem()).toBe('You are a helpful assistant.');
  });

  it('resolveSystem calls function when system is a function', () => {
    const a = agent({
      model: 'openai:gpt-4o',
      system: (ctx) => `You are helping user with tier: ${ctx.metadata?.tier ?? 'unknown'}`,
    });

    expect(a.resolveSystem({ metadata: { tier: 'premium' } })).toBe(
      'You are helping user with tier: premium',
    );
    expect(a.resolveSystem()).toBe('You are helping user with tier: unknown');
  });

  // ── ask() ────────────────────────────────────────────────────────────────

  it('direct ask() attempts provider invocation', async () => {
    const a = agent({
      model: 'nonexistent:test-model',
      system: 'Test',
    });

    // Direct ask() creates a lightweight context and calls the provider.
    // An unknown provider name rejects immediately — proves invocation was attempted
    // without hitting a real API (avoids flaky timeouts).
    await expect(a.ask('hello')).rejects.toThrow(/Unknown provider "nonexistent"/);
  });

  // ── _config ──────────────────────────────────────────────────────────────

  it('_config exposes all configuration properties', () => {
    const tools: any[] = [];
    const handoffs: any[] = [];

    const a = agent({
      model: 'openai:gpt-4o',
      system: 'You are an assistant.',
      tools,
      handoffs,
      temperature: 0.7,
      maxTurns: 10,
      timeout: '120s',
      maxContext: 8000,
      version: 'v2.1',
    });

    expect(a._config.model).toBe('openai:gpt-4o');
    expect(a._config.system).toBe('You are an assistant.');
    expect(a._config.tools).toBe(tools);
    expect(a._config.handoffs).toBe(handoffs);
    expect(a._config.temperature).toBe(0.7);
    expect(a._config.maxTurns).toBe(10);
    expect(a._config.timeout).toBe('120s');
    expect(a._config.maxContext).toBe(8000);
    expect(a._config.version).toBe('v2.1');
  });

  it('_config has undefined for optional fields when not provided', () => {
    const a = agent({
      model: 'openai:gpt-4o',
      system: 'Test',
    });

    expect(a._config.tools).toBeUndefined();
    expect(a._config.handoffs).toBeUndefined();
    expect(a._config.temperature).toBeUndefined();
    expect(a._config.maxTurns).toBeUndefined();
    expect(a._config.timeout).toBeUndefined();
    expect(a._config.maxContext).toBeUndefined();
    expect(a._config.version).toBeUndefined();
  });
});
