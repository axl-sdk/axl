import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, findConfig, needsTsxLoader, CONFIG_CANDIDATES } from '../cli-utils.js';

// ── parseArgs ──────────────────────────────────────────────────────

describe('parseArgs', () => {
  // Helper: argv[0] = node, argv[1] = script, rest = user args
  const argv = (...args: string[]) => ['node', 'cli.js', ...args];

  it('returns defaults when no args provided', () => {
    const result = parseArgs(argv());
    expect(result).toEqual({
      port: 4400,
      config: undefined,
      open: false,
      help: false,
      conditions: [],
      readOnly: false,
    });
  });

  it('parses --port', () => {
    expect(parseArgs(argv('--port', '3000')).port).toBe(3000);
  });

  it('parses --config', () => {
    expect(parseArgs(argv('--config', './my-config.mts')).config).toBe('./my-config.mts');
  });

  it('parses --open', () => {
    expect(parseArgs(argv('--open')).open).toBe(true);
  });

  it('parses --read-only', () => {
    expect(parseArgs(argv('--read-only')).readOnly).toBe(true);
  });

  it('parses --readonly as alias', () => {
    expect(parseArgs(argv('--readonly')).readOnly).toBe(true);
  });

  it('parses --conditions with single value', () => {
    expect(parseArgs(argv('--conditions', 'development')).conditions).toEqual(['development']);
  });

  it('parses --conditions with comma-separated values', () => {
    expect(parseArgs(argv('--conditions', 'development,custom')).conditions).toEqual([
      'development',
      'custom',
    ]);
  });

  it('trims whitespace in --conditions values', () => {
    expect(parseArgs(argv('--conditions', ' dev , custom ')).conditions).toEqual(['dev', 'custom']);
  });

  it('filters empty entries from --conditions', () => {
    expect(parseArgs(argv('--conditions', 'dev,,custom,')).conditions).toEqual(['dev', 'custom']);
  });

  it('parses multiple flags together', () => {
    const result = parseArgs(
      argv('--port', '8080', '--config', 'app.mts', '--open', '--conditions', 'development'),
    );
    expect(result).toEqual({
      port: 8080,
      config: 'app.mts',
      open: true,
      help: false,
      conditions: ['development'],
      readOnly: false,
    });
  });

  it('ignores flag without value for --port', () => {
    // --port is the last arg, no value follows — port stays at default
    const result = parseArgs(argv('--port'));
    expect(result.port).toBe(4400);
  });

  it('ignores flag without value for --config', () => {
    const result = parseArgs(argv('--config'));
    expect(result.config).toBeUndefined();
  });

  it('ignores flag without value for --conditions', () => {
    const result = parseArgs(argv('--conditions'));
    expect(result.conditions).toEqual([]);
  });

  it('parses --help', () => {
    expect(parseArgs(argv('--help')).help).toBe(true);
  });

  it('parses -h', () => {
    expect(parseArgs(argv('-h')).help).toBe(true);
  });

  it('sets portError for NaN port', () => {
    const result = parseArgs(argv('--port', 'abc'));
    expect(result.portError).toMatch(/Invalid port/);
  });

  it('sets portError for port 0', () => {
    const result = parseArgs(argv('--port', '0'));
    expect(result.portError).toMatch(/Invalid port/);
  });

  it('sets portError for port > 65535', () => {
    const result = parseArgs(argv('--port', '99999'));
    expect(result.portError).toMatch(/Invalid port/);
  });

  it('sets portError for negative port', () => {
    const result = parseArgs(argv('--port', '-1'));
    expect(result.portError).toMatch(/Invalid port/);
  });

  it('no portError for valid port', () => {
    expect(parseArgs(argv('--port', '8080')).portError).toBeUndefined();
  });

  it('no portError for default port', () => {
    expect(parseArgs(argv()).portError).toBeUndefined();
  });
});

// ── findConfig ─────────────────────────────────────────────────────

describe('findConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'axl-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no config file exists', () => {
    expect(findConfig(tmpDir)).toBeUndefined();
  });

  it('finds axl.config.mts', () => {
    writeFileSync(join(tmpDir, 'axl.config.mts'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.mts'));
  });

  it('finds axl.config.ts', () => {
    writeFileSync(join(tmpDir, 'axl.config.ts'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.ts'));
  });

  it('finds axl.config.mjs', () => {
    writeFileSync(join(tmpDir, 'axl.config.mjs'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.mjs'));
  });

  it('finds axl.config.js', () => {
    writeFileSync(join(tmpDir, 'axl.config.js'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.js'));
  });

  it('prefers .mts over .ts', () => {
    writeFileSync(join(tmpDir, 'axl.config.mts'), '');
    writeFileSync(join(tmpDir, 'axl.config.ts'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.mts'));
  });

  it('prefers .ts over .mjs', () => {
    writeFileSync(join(tmpDir, 'axl.config.ts'), '');
    writeFileSync(join(tmpDir, 'axl.config.mjs'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.ts'));
  });

  it('prefers .mjs over .js', () => {
    writeFileSync(join(tmpDir, 'axl.config.mjs'), '');
    writeFileSync(join(tmpDir, 'axl.config.js'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.mjs'));
  });

  it('falls back to .js when only .js exists', () => {
    writeFileSync(join(tmpDir, 'axl.config.js'), '');
    expect(findConfig(tmpDir)).toBe(join(tmpDir, 'axl.config.js'));
  });
});

// ── needsTsxLoader ─────────────────────────────────────────────────

describe('needsTsxLoader', () => {
  it('returns true for .ts', () => {
    expect(needsTsxLoader('/project/axl.config.ts')).toBe(true);
  });

  it('returns true for .tsx', () => {
    expect(needsTsxLoader('/project/axl.config.tsx')).toBe(true);
  });

  it('returns true for .mts', () => {
    expect(needsTsxLoader('/project/axl.config.mts')).toBe(true);
  });

  it('returns true for .cts', () => {
    expect(needsTsxLoader('/project/axl.config.cts')).toBe(true);
  });

  it('returns false for .js', () => {
    expect(needsTsxLoader('/project/axl.config.js')).toBe(false);
  });

  it('returns false for .mjs', () => {
    expect(needsTsxLoader('/project/axl.config.mjs')).toBe(false);
  });

  it('returns false for .cjs', () => {
    expect(needsTsxLoader('/project/axl.config.cjs')).toBe(false);
  });
});

// ── CONFIG_CANDIDATES ──────────────────────────────────────────────

describe('CONFIG_CANDIDATES', () => {
  it('has .mts first (highest priority)', () => {
    expect(CONFIG_CANDIDATES[0]).toBe('axl.config.mts');
  });

  it('contains all 4 expected candidates', () => {
    expect(CONFIG_CANDIDATES).toEqual([
      'axl.config.mts',
      'axl.config.ts',
      'axl.config.mjs',
      'axl.config.js',
    ]);
  });
});
