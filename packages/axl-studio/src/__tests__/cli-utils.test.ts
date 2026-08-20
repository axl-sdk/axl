import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs,
  findConfig,
  needsTsxLoader,
  CONFIG_CANDIDATES,
  STUDIO_CLI_HOST,
  isAllowedStandaloneHost,
  isAllowedStandaloneOrigin,
  isAllowedStandaloneRequest,
  withStandaloneRequestGuard,
} from '../cli-utils.js';

describe('standalone network boundary', () => {
  it('binds the CLI to explicit IPv4 loopback', () => {
    expect(STUDIO_CLI_HOST).toBe('127.0.0.1');
  });

  it.each([undefined, 'http://localhost:4400', 'http://localhost.:4401', 'https://127.0.0.1'])(
    'accepts local or absent browser Origin %s',
    (origin) => {
      expect(isAllowedStandaloneOrigin(origin)).toBe(true);
    },
  );

  it.each([
    'https://example.com',
    'http://localhost.evil.test',
    'null',
    'file:///',
    'http://localhost/path',
    'not a url',
  ])('rejects non-local or malformed browser Origin %s', (origin) => {
    expect(isAllowedStandaloneOrigin(origin)).toBe(false);
  });

  it.each(['localhost:4400', 'localhost.:4400', '127.0.0.1:4400', '127.1:4400'])(
    'accepts loopback Host %s',
    (host) => {
      expect(isAllowedStandaloneHost(host)).toBe(true);
    },
  );

  it.each([undefined, 'studio.attacker.test:4400', 'localhost.evil.test', 'evil@127.0.0.1'])(
    'rejects missing, rebinding, or malformed Host %s',
    (host) => {
      expect(isAllowedStandaloneHost(host)).toBe(false);
    },
  );

  it('rejects a hostile simple POST before invoking the Studio app', async () => {
    const appFetch = vi.fn(async () => Response.json({ secret: 'prompt' }));
    const guardedFetch = withStandaloneRequestGuard(appFetch);
    const response = await guardedFetch(
      new Request('http://127.0.0.1:4400/api/tools/danger/test', {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4400',
          Origin: 'https://attacker.test',
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({ input: 'run' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(appFetch).not.toHaveBeenCalled();
  });

  it('rejects a DNS-rebinding read before invoking the Studio app', async () => {
    const appFetch = vi.fn(async () => Response.json({ system: 'secret prompt' }));
    const guardedFetch = withStandaloneRequestGuard(appFetch);
    const response = await guardedFetch(
      new Request('http://studio.attacker.test:4400/api/agents', {
        headers: { Host: 'studio.attacker.test:4400' },
      }),
    );

    expect(response.status).toBe(403);
    expect(appFetch).not.toHaveBeenCalled();
  });

  it('passes a local request through to the Studio app', async () => {
    const appFetch = vi.fn(async () => Response.json({ ok: true }));
    const response = await withStandaloneRequestGuard(appFetch)(
      new Request('http://localhost:4400/api/health', {
        headers: { Host: 'localhost:4400', Origin: 'http://localhost:4400' },
      }),
    );

    expect(isAllowedStandaloneRequest('localhost:4400', 'http://localhost:4400')).toBe(true);
    expect(response.status).toBe(200);
    expect(appFetch).toHaveBeenCalledOnce();
  });
});

// ── parseArgs ──────────────────────────────────────────────────────

describe('parseArgs', () => {
  // Helper: argv[0] = node, argv[1] = script, rest = user args
  const argv = (...args: string[]) => ['node', 'cli.js', ...args];

  it('returns defaults when no args provided', () => {
    const result = parseArgs(argv());
    expect(result).toEqual({
      port: 4400,
      host: '127.0.0.1',
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

  it('parses the explicit dangerous bind escape hatch', () => {
    expect(parseArgs(argv('--dangerously-bind', '0.0.0.0')).host).toBe('0.0.0.0');
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
      host: '127.0.0.1',
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
