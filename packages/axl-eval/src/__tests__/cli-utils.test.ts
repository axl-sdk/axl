import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONFIG_CANDIDATES,
  findConfig,
  needsEsmForcing,
  needsTsxLoader,
  resolveRuntime,
} from '../cli-utils.js';

describe('CONFIG_CANDIDATES', () => {
  it('contains 4 candidates in priority order', () => {
    expect(CONFIG_CANDIDATES).toEqual([
      'axl.config.mts',
      'axl.config.ts',
      'axl.config.mjs',
      'axl.config.js',
    ]);
  });
});

describe('needsEsmForcing()', () => {
  it('returns true for .ts', () => {
    expect(needsEsmForcing('axl.config.ts')).toBe(true);
  });

  it('returns true for .tsx', () => {
    expect(needsEsmForcing('axl.config.tsx')).toBe(true);
  });

  it('returns false for .mts', () => {
    expect(needsEsmForcing('axl.config.mts')).toBe(false);
  });

  it('returns false for .cts', () => {
    expect(needsEsmForcing('axl.config.cts')).toBe(false);
  });

  it('returns false for .js', () => {
    expect(needsEsmForcing('axl.config.js')).toBe(false);
  });

  it('returns false for .mjs', () => {
    expect(needsEsmForcing('axl.config.mjs')).toBe(false);
  });

  it('returns true for full path ending in .ts', () => {
    expect(needsEsmForcing('/path/to/config.ts')).toBe(true);
  });
});

describe('needsTsxLoader()', () => {
  it('returns true for .ts', () => {
    expect(needsTsxLoader('axl.config.ts')).toBe(true);
  });

  it('returns true for .tsx', () => {
    expect(needsTsxLoader('axl.config.tsx')).toBe(true);
  });

  it('returns true for .mts', () => {
    expect(needsTsxLoader('axl.config.mts')).toBe(true);
  });

  it('returns true for .cts', () => {
    expect(needsTsxLoader('axl.config.cts')).toBe(true);
  });

  it('returns false for .js', () => {
    expect(needsTsxLoader('axl.config.js')).toBe(false);
  });

  it('returns false for .mjs', () => {
    expect(needsTsxLoader('axl.config.mjs')).toBe(false);
  });

  it('returns false for .cjs', () => {
    expect(needsTsxLoader('axl.config.cjs')).toBe(false);
  });

  it('returns true for full path ending in .mts', () => {
    expect(needsTsxLoader('/path/to/config.mts')).toBe(true);
  });
});

describe('resolveRuntime()', () => {
  it('resolves ESM default export', () => {
    const runtime = { execute: () => {} };
    expect(resolveRuntime({ default: runtime })).toBe(runtime);
  });

  it('resolves CJS double-wrapped default', () => {
    const runtime = { execute: () => {} };
    expect(resolveRuntime({ default: { default: runtime } })).toBe(runtime);
  });

  it('resolves named runtime export', () => {
    const runtime = { execute: () => {} };
    expect(resolveRuntime({ runtime })).toBe(runtime);
  });

  it('returns undefined for empty module', () => {
    expect(resolveRuntime({})).toBeUndefined();
  });

  it('returns undefined when default is undefined', () => {
    expect(resolveRuntime({ default: undefined })).toBeUndefined();
  });

  it('prefers default over named runtime export', () => {
    const runtimeA = { name: 'a' };
    const runtimeB = { name: 'b' };
    expect(resolveRuntime({ default: runtimeA, runtime: runtimeB })).toBe(runtimeA);
  });
});

describe('findConfig()', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'axl-eval-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('returns first match when axl.config.mts exists', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'axl.config.mts'), '');
    writeFileSync(join(dir, 'axl.config.ts'), '');

    expect(findConfig(dir)).toBe(join(dir, 'axl.config.mts'));
  });

  it('returns axl.config.ts when only that exists', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'axl.config.ts'), '');

    expect(findConfig(dir)).toBe(join(dir, 'axl.config.ts'));
  });

  it('returns undefined when no config files exist', () => {
    const dir = makeTempDir();

    expect(findConfig(dir)).toBeUndefined();
  });

  it('respects priority order: mts before ts before mjs before js', () => {
    const dir = makeTempDir();

    // Only js exists
    writeFileSync(join(dir, 'axl.config.js'), '');
    expect(findConfig(dir)).toBe(join(dir, 'axl.config.js'));

    // Add mjs — should win over js
    writeFileSync(join(dir, 'axl.config.mjs'), '');
    expect(findConfig(dir)).toBe(join(dir, 'axl.config.mjs'));

    // Add ts — should win over mjs
    writeFileSync(join(dir, 'axl.config.ts'), '');
    expect(findConfig(dir)).toBe(join(dir, 'axl.config.ts'));

    // Add mts — should win over ts
    writeFileSync(join(dir, 'axl.config.mts'), '');
    expect(findConfig(dir)).toBe(join(dir, 'axl.config.mts'));
  });
});
