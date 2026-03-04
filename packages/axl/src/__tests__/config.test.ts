import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseDuration, parseCost, defineConfig, resolveConfig } from '../config.js';

describe('parseDuration()', () => {
  it('parses "30s" to 30000ms', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses "500ms" to 500ms', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses "5m" to 300000ms', () => {
    expect(parseDuration('5m')).toBe(300000);
  });

  it('parses "2h" to 7200000ms', () => {
    expect(parseDuration('2h')).toBe(7200000);
  });

  it('parses fractional values like "1.5s"', () => {
    expect(parseDuration('1.5s')).toBe(1500);
  });

  it('parses "0ms" to 0', () => {
    expect(parseDuration('0ms')).toBe(0);
  });

  it('throws on invalid format "foo"', () => {
    expect(() => parseDuration('foo')).toThrow('Invalid duration format');
  });

  it('throws on empty string', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration format');
  });

  it('throws on missing unit', () => {
    expect(() => parseDuration('100')).toThrow('Invalid duration format');
  });

  it('throws on missing value', () => {
    expect(() => parseDuration('ms')).toThrow('Invalid duration format');
  });
});

describe('parseCost()', () => {
  it('parses "$5.00" to 5', () => {
    expect(parseCost('$5.00')).toBe(5);
  });

  it('parses "2.50" to 2.5', () => {
    expect(parseCost('2.50')).toBe(2.5);
  });

  it('parses "$0.01" to 0.01', () => {
    expect(parseCost('$0.01')).toBe(0.01);
  });

  it('parses "100" to 100', () => {
    expect(parseCost('100')).toBe(100);
  });

  it('throws on invalid format "abc"', () => {
    expect(() => parseCost('abc')).toThrow('Invalid cost format');
  });

  it('throws on empty string', () => {
    expect(() => parseCost('')).toThrow('Invalid cost format');
  });
});

describe('defineConfig()', () => {
  it('returns config as-is (identity function)', () => {
    const config = {
      defaultProvider: 'openai',
      providers: {
        openai: { apiKey: 'sk-test' },
      },
      trace: { enabled: true, level: 'full' as const },
    };
    const result = defineConfig(config);
    expect(result).toBe(config);
  });

  it('accepts empty config', () => {
    const result = defineConfig({});
    expect(result).toEqual({});
  });
});

describe('resolveConfig()', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean up environment variables we test
    delete process.env.AXL_DEFAULT_PROVIDER;
    delete process.env.AXL_STATE_STORE;
    delete process.env.AXL_TRACE_ENABLED;
    delete process.env.AXL_TRACE_LEVEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it('returns config unchanged when no env vars are set', () => {
    const config = { defaultProvider: 'anthropic' };
    const resolved = resolveConfig(config);
    expect(resolved.defaultProvider).toBe('anthropic');
  });

  it('overrides defaultProvider from AXL_DEFAULT_PROVIDER env var', () => {
    process.env.AXL_DEFAULT_PROVIDER = 'anthropic';
    const resolved = resolveConfig({ defaultProvider: 'openai' });
    expect(resolved.defaultProvider).toBe('anthropic');
  });

  it('overrides state store from AXL_STATE_STORE env var', () => {
    process.env.AXL_STATE_STORE = 'sqlite';
    const resolved = resolveConfig({});
    expect(resolved.state?.store).toBe('sqlite');
  });

  it('overrides trace enabled from AXL_TRACE_ENABLED env var', () => {
    process.env.AXL_TRACE_ENABLED = 'true';
    const resolved = resolveConfig({});
    expect(resolved.trace?.enabled).toBe(true);
  });

  it('sets trace enabled to false for non-"true" value', () => {
    process.env.AXL_TRACE_ENABLED = 'false';
    const resolved = resolveConfig({});
    expect(resolved.trace?.enabled).toBe(false);
  });

  it('overrides trace level from AXL_TRACE_LEVEL env var', () => {
    process.env.AXL_TRACE_LEVEL = 'full';
    const resolved = resolveConfig({});
    expect(resolved.trace?.level).toBe('full');
  });

  it('merges OPENAI_API_KEY when openai provider is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const resolved = resolveConfig({
      providers: { openai: { apiKey: 'sk-original' } },
    });
    expect(resolved.providers?.openai?.apiKey).toBe('sk-from-env');
  });

  it('creates openai provider entry from OPENAI_API_KEY when not pre-configured', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const resolved = resolveConfig({});
    expect(resolved.providers?.openai?.apiKey).toBe('sk-from-env');
  });

  it('merges ANTHROPIC_API_KEY when anthropic provider is configured', () => {
    process.env.ANTHROPIC_API_KEY = 'ant-from-env';
    const resolved = resolveConfig({
      providers: { anthropic: { apiKey: 'ant-original' } },
    });
    expect(resolved.providers?.anthropic?.apiKey).toBe('ant-from-env');
  });

  it('merges multiple env overrides simultaneously', () => {
    process.env.AXL_DEFAULT_PROVIDER = 'anthropic';
    process.env.AXL_TRACE_ENABLED = 'true';
    process.env.AXL_TRACE_LEVEL = 'steps';

    const resolved = resolveConfig({});
    expect(resolved.defaultProvider).toBe('anthropic');
    expect(resolved.trace?.enabled).toBe(true);
    expect(resolved.trace?.level).toBe('steps');
  });
});
