import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONFIG_CANDIDATES,
  expandGlob,
  findConfig,
  importModule,
  needsTsxLoader,
  pickDefault,
  pickExport,
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

describe('pickExport()', () => {
  // The bug fixed by pickExport: when tsx loads a `.ts` eval module from a
  // package without `"type": "module"`, named exports can end up under
  // `mod.default.<name>` rather than `mod.<name>`. The default export already
  // walks the chain (`mod.default?.default ?? mod.default ?? mod.config ?? mod`)
  // — pickExport applies the same chain to named exports so the resolution
  // is symmetric.
  const fn = () => 'sentinel';

  it('returns top-level export (ESM)', () => {
    expect(pickExport({ executeWorkflow: fn }, 'executeWorkflow')).toBe(fn);
  });

  it('returns mod.default.<key> when CJS-wrapped under default', () => {
    // tsx → CJS in non-"type":"module" packages: `exports.default = cfg;
    // exports.executeWorkflow = fn;` re-imported by ESM puts both under
    // mod.default.
    const mod = { default: { default: { workflow: 'x' }, executeWorkflow: fn } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(fn);
  });

  it('returns mod.default.default.<key> on rare double-wrap', () => {
    const mod = { default: { default: { executeWorkflow: fn } } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(fn);
  });

  it('prefers top-level over wrapped when both exist', () => {
    const top = () => 'top';
    const wrapped = () => 'wrapped';
    const mod = { executeWorkflow: top, default: { executeWorkflow: wrapped } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(top);
  });

  it('returns undefined when key is absent at every level', () => {
    expect(pickExport({}, 'executeWorkflow')).toBeUndefined();
    expect(pickExport({ default: {} }, 'executeWorkflow')).toBeUndefined();
    expect(pickExport({ default: { default: {} } }, 'executeWorkflow')).toBeUndefined();
  });

  it('returns undefined when default is null/undefined', () => {
    expect(pickExport({ default: undefined }, 'executeWorkflow')).toBeUndefined();
    expect(
      pickExport({ default: null as unknown as undefined }, 'executeWorkflow'),
    ).toBeUndefined();
  });
});

describe('pickDefault()', () => {
  it('walks the chain like the prior inline expression', () => {
    const cfg = { workflow: 'wf' };
    expect(pickDefault({ default: cfg })).toBe(cfg);
    expect(pickDefault({ default: { default: cfg } })).toBe(cfg);
    expect(pickDefault({ config: cfg })).toBe(cfg);
    expect(pickDefault(cfg)).toBe(cfg);
  });

  it('prefers default.default over default over config over self', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(pickDefault({ default: { default: a }, config: b })).toBe(a);
  });
});

// End-to-end test that exercises `importModule + pickExport + pickDefault`
// against modules loaded by Node's actual CJS/ESM interop, not synthetic
// in-memory shapes. Modern Node promotes statically-discoverable named
// exports to the top level, but interop emitted by various transpilers
// (or by dynamic `module.exports = ...` patterns) does NOT always promote
// — that's the original bug class. These tests assert pickExport finds
// the export regardless of where interop landed it (top-level OR nested
// under `mod.default`), which is the invariant the helper exists to enforce.
describe('importModule + pickExport (CJS interop)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'axl-eval-cjs-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('finds executeWorkflow on a real .cjs module loaded via importModule', async () => {
    const dir = makeTempDir();
    const fixturePath = join(dir, 'eval.cjs');
    writeFileSync(
      fixturePath,
      `module.exports = {
  default: {
    workflow: 'wf',
    dataset: { name: 'ds', getItems: async () => [] },
    scorers: [{ name: 's', score: () => 1 }],
  },
  executeWorkflow: async (input) => ({ output: input }),
};
`,
    );

    const mod = await importModule(fixturePath, import.meta.url);

    const fn = pickExport<(input: unknown) => Promise<{ output: unknown }>>(mod, 'executeWorkflow');
    expect(typeof fn).toBe('function');
    const result = await fn!('hello');
    expect(result).toEqual({ output: 'hello' });

    const cfg = pickDefault<{ workflow: string }>(mod);
    expect(cfg.workflow).toBe('wf');
  });

  // The pathological shape from the bug repro — `mod.default.executeWorkflow`
  // exists but `mod.executeWorkflow` does not — depends on which transpiler
  // emitted the CJS and which Node-version / loader-hook resolved the import.
  // We can't reliably synthesize that shape from a single test fixture, so
  // we instead simulate the dynamically-imported namespace directly and feed
  // it through pickExport. This proves the helper handles the shape; the
  // first test above proves it cooperates with `importModule` end-to-end.
  it('handles the mod.default-only shape that caused the original bug', async () => {
    const fn = async (input: string) => ({ output: 'wrapped:' + input });
    const mod = {
      default: {
        default: { workflow: 'wf' },
        executeWorkflow: fn,
      },
    };

    const found = pickExport<(input: string) => Promise<{ output: string }>>(
      mod,
      'executeWorkflow',
    );
    expect(found).toBe(fn);
    expect(await found!('x')).toEqual({ output: 'wrapped:x' });

    const cfg = pickDefault<{ workflow: string }>(mod);
    expect(cfg.workflow).toBe('wf');
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

describe('expandGlob()', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'axl-eval-glob-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('matches files in a single directory: dir/*.eval.ts', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.eval.ts'), '');
    writeFileSync(join(dir, 'b.eval.ts'), '');
    writeFileSync(join(dir, 'c.test.ts'), '');

    const matches = expandGlob('*.eval.ts', dir).sort();
    expect(matches).toEqual([join(dir, 'a.eval.ts'), join(dir, 'b.eval.ts')]);
  });

  it('does NOT recurse on single-star patterns', () => {
    const dir = makeTempDir();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(dir, 'top.eval.ts'), '');
    writeFileSync(join(sub, 'nested.eval.ts'), '');

    const matches = expandGlob('*.eval.ts', dir);
    expect(matches).toEqual([join(dir, 'top.eval.ts')]);
  });

  it('recurses on **/ patterns: dir/**/*.eval.ts', () => {
    const dir = makeTempDir();
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, 'top.eval.ts'), '');
    writeFileSync(join(sub, 'deep.eval.ts'), '');

    const matches = expandGlob(join(dir, '**/*.eval.ts'), '/').sort();
    expect(matches).toEqual([join(sub, 'deep.eval.ts'), join(dir, 'top.eval.ts')]);
  });

  it('recurses from cwd on bare **/ patterns', () => {
    const dir = makeTempDir();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'x.eval.ts'), '');

    const matches = expandGlob('**/*.eval.ts', dir);
    expect(matches).toEqual([join(sub, 'x.eval.ts')]);
  });

  it('returns empty array for non-existent directories', () => {
    expect(expandGlob('/does/not/exist/*.eval.ts', '/')).toEqual([]);
  });

  it('escapes regex metacharacters in the file portion', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.eval.ts'), '');
    writeFileSync(join(dir, 'a+eval.ts'), '');

    // The `+` should be a literal character, not a regex quantifier
    const matches = expandGlob('a+eval.ts', dir);
    expect(matches).toEqual([join(dir, 'a+eval.ts')]);
  });
});
