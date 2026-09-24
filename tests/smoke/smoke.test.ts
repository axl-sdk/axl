import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '../..');

function pack(pkgDir: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'axl-smoke-'));
  execSync(`pnpm pack --pack-destination ${tmpDir}`, { cwd: pkgDir, stdio: 'pipe' });
  const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'));
  expect(tarballs.length).toBe(1);
  return join(tmpDir, tarballs[0]);
}

function packAndList(pkgDir: string): string[] {
  const tarball = pack(pkgDir);
  const listing = execSync(`tar -tf ${tarball}`, { encoding: 'utf-8' });
  return listing.split('\n').filter(Boolean);
}

describe('Smoke: Package Tarballs', () => {
  it('@axlsdk/axl tarball contains required dist files', () => {
    const files = packAndList(join(ROOT, 'packages/axl'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    // No source files or secrets
    const hasSrc = files.some((f) => f.includes('/src/'));
    const hasEnv = files.some((f) => f.includes('.env'));
    const hasTsconfig = files.some((f) => f.endsWith('tsconfig.json'));
    expect(hasSrc).toBe(false);
    expect(hasEnv).toBe(false);
    expect(hasTsconfig).toBe(false);
  });

  it('@axlsdk/testing tarball contains required dist files', () => {
    const files = packAndList(join(ROOT, 'packages/axl-testing'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    expect(hasSrc).toBe(false);
  });

  it('@axlsdk/eval tarball contains required dist files and CLI', () => {
    const files = packAndList(join(ROOT, 'packages/axl-eval'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.cjs'));
    expect(files).toContainEqual(expect.stringContaining('dist/index.d.ts'));
    expect(files).toContainEqual(expect.stringContaining('dist/cli.js'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    expect(hasSrc).toBe(false);
  });

  it('@axlsdk/studio tarball contains server, CLI, middleware, and client', () => {
    const files = packAndList(join(ROOT, 'packages/axl-studio'));
    // Server entry (default export)
    expect(files).toContainEqual(expect.stringContaining('dist/server/index.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/server/index.d.ts'));
    // CLI
    expect(files).toContainEqual(expect.stringContaining('dist/cli.js'));
    // Middleware entry (./middleware export)
    expect(files).toContainEqual(expect.stringContaining('dist/middleware.js'));
    expect(files).toContainEqual(expect.stringContaining('dist/middleware.d.ts'));
    // Pre-built SPA
    expect(files).toContainEqual(expect.stringContaining('dist/client/index.html'));
    expect(files).toContainEqual(expect.stringContaining('package.json'));

    const hasSrc = files.some((f) => f.includes('/src/'));
    const hasEnv = files.some((f) => f.includes('.env'));
    expect(hasSrc).toBe(false);
    expect(hasEnv).toBe(false);
  });

  it('@axlsdk/studio CJS middleware bundle has __filename fallback for import.meta.url', () => {
    // tsup stubs import.meta as {} in CJS output, so import.meta.url is
    // undefined. The eval loader must fall back to __filename to build a
    // valid parentURL for tsImport(). This test reads the built CJS bundle
    // to verify the fallback is present.
    const cjs = readFileSync(join(ROOT, 'packages/axl-studio/dist/middleware.cjs'), 'utf-8');
    // The parentURL computation should reference __filename as a fallback
    expect(cjs).toContain('__filename');
    // And it should use pathToFileURL to convert __filename to a file:// URL
    expect(cjs).toMatch(/pathToFileURL.*__filename/);
  });
});

/**
 * Type-export contract smoke test.
 *
 * The CONTENT smoke tests above only verify that `dist/index.d.ts` is
 * present in the tarball — they don't exercise that downstream consumers
 * can actually narrow against the published types. The unified event
 * model collapsed two surfaces into one (`AxlEvent`) and removed
 * `parentToolCallId`; tsup's `.d.ts` bundler could silently drop a
 * type during a future refactor and the existing smoke suite would
 * never notice.
 *
 * This test installs the packed tarball into a sandbox npm project,
 * writes a synthetic consumer that exercises `AxlEvent` discriminated
 * narrowing + `AxlEventOf` + `AskScoped`, and runs `tsc --noEmit`.
 * A green typecheck proves the published types support real consumer
 * code under `strict: true`.
 *
 * Slow by design — `npm install` from a local tarball can take 10–30s.
 * Vitest's `testTimeout: 60_000` (configured in `vitest.config.ts`)
 * accommodates this.
 */
describe('Smoke: Downstream Type Export Contract', () => {
  it('@axlsdk/axl types support AxlEvent narrowing in a downstream consumer', () => {
    // Pack the core SDK tarball.
    const tarball = pack(join(ROOT, 'packages/axl'));

    // Build a sandbox project that depends on the tarball + zod (the
    // single required peer dep) and runs tsc against a consumer file.
    const sandbox = mkdtempSync(join(tmpdir(), 'axl-types-smoke-'));

    // Minimal package.json — note we install from the local tarball
    // path so the sandbox has the same dist/ that publish would deliver.
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(
        {
          name: 'axl-smoke-consumer',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: {
            '@axlsdk/axl': `file:${tarball}`,
            zod: '^4.0.0',
          },
          devDependencies: {
            // Pin a TypeScript version compatible with the strict mode
            // + bundler resolution + verbatimModuleSyntax combo used in
            // the sandbox tsconfig below.
            typescript: '^5.7.0',
          },
        },
        null,
        2,
      ),
    );

    // Strict tsconfig — bundler resolution mirrors the recommended
    // setup in the public docs and catches cases where the published
    // `.d.ts` doesn't compose cleanly under `strict: true`.
    writeFileSync(
      join(sandbox, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            verbatimModuleSyntax: true,
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      ),
    );

    // Synthetic consumer — exercises the type surfaces most likely to
    // regress under tsup `.d.ts` bundler changes:
    //   - `AxlEvent` discriminated union narrowing on `event.type`
    //   - per-variant fields that are required after narrowing
    //     (`tool` on `tool_call_end`, `outcome` on `ask_end`, etc)
    //   - `AxlEventOf<'agent_call_end'>.cost` (numeric rollup field
    //     pinned by spec/16 decision 10)
    //   - `AskScoped` mixin exhaustiveness (default branch coerces
    //     `event.type` to `string` — proves the union is closed)
    //
    // The function never runs; tsc only typechecks.
    writeFileSync(
      join(sandbox, 'consumer.ts'),
      [
        "import { ToolFailure } from '@axlsdk/axl';",
        "import type { AxlEvent, AxlEventOf, AskScoped, AxlRuntime } from '@axlsdk/axl';",
        '',
        'export function inspect(ev: AxlEvent): void {',
        '  switch (ev.type) {',
        "    case 'agent_call_end': {",
        '      // cost is `number | undefined` on agent_call_end — undefined for an',
        '      // unpriced model (pricing-table miss) or the error path (unpriced-cost honesty).',
        '      const _cost: number | undefined = ev.cost;',
        '      void _cost;',
        '      break;',
        '    }',
        "    case 'tool_call_end': {",
        '      // v2 tool ends carry explicit schema/correlation and a terminal outcome.',
        '      const _tool: string = ev.tool;',
        '      const _schema: 2 = ev.schemaVersion;',
        "      if (ev.data.outcome.status === 'succeeded') void ev.data.outcome.result;",
        '      void _tool;',
        '      void _schema;',
        '      break;',
        '    }',
        "    case 'ask_end': {",
        '      // outcome is a required discriminated union on ask_end',
        '      const _outcome: typeof ev.outcome = ev.outcome;',
        '      void _outcome;',
        '      break;',
        '    }',
        "    case 'pipeline': {",
        "      // pipeline carries `status: 'start' | 'failed' | 'committed'`",
        '      const _status: typeof ev.status = ev.status;',
        '      void _status;',
        '      break;',
        '    }',
        "    case 'token': {",
        "      // token's data is a string (text delta)",
        '      const _data: string = ev.data;',
        '      void _data;',
        '      break;',
        '    }',
        '    default: {',
        '      // Closed-union default — `ev.type` is a string of the remaining variants.',
        '      const _t: string = ev.type;',
        '      void _t;',
        '      break;',
        '    }',
        '  }',
        '}',
        '',
        'declare const runtime: AxlRuntime;',
        '// @ts-expect-error observation callbacks were removed from createContext',
        'runtime.createContext({ onToken: () => {} });',
        '',
        'const failure: Error = new ToolFailure({',
        "  message: 'host diagnostic',",
        "  modelMessage: 'safe recovery instruction',",
        '});',
        'void failure;',
        '',
        '// AxlEventOf extracts a single variant — pin its `cost` field to catch a',
        "// regression where the helper or the variant's `cost` type drops. `cost` is",
        '// optional (`number | undefined`) as of the unpriced-cost honesty change.',
        "export function readAgentCallCost(ev: AxlEventOf<'agent_call_end'>): number | undefined {",
        '  return ev.cost;',
        '}',
        '',
        '// AskScoped mixin — askId/depth must be statically narrowable.',
        'export function readAsk(meta: AskScoped): { id: string; depth: number } {',
        '  return { id: meta.askId, depth: meta.depth };',
        '}',
        '',
      ].join('\n'),
    );

    // Install the tarball + zod into the sandbox. Use `npm install`
    // (not pnpm) to keep the test framework-agnostic and avoid pulling
    // the workspace's pnpm config into the sandbox.
    execSync('npm install --no-audit --no-fund --loglevel=error', {
      cwd: sandbox,
      stdio: 'pipe',
      timeout: 50_000,
    });

    // Typecheck via the sandbox's installed tsc (zod ships its own .d.ts
    // and @axlsdk/axl's d.ts must compose with it under strict mode).
    // Using `npx --no-install` ensures we use the LOCAL tsc rather than
    // accidentally falling back to a globally-installed version.
    execSync('npx --no-install tsc --noEmit -p tsconfig.json', {
      cwd: sandbox,
      stdio: 'pipe',
    });
    // If tsc exits non-zero, execSync throws and the test fails with
    // the stderr captured. A clean exit means the consumer compiles.
  });
});

/**
 * A16.15 — the packaged tarballs, exercised by specifier.
 *
 * The suites above check that files are IN the tarball and that the types
 * compose. Neither would notice a new module missing from the `tsup` entry
 * list or the `exports` map: source-relative tests import through the
 * workspace and stay green while `import { runEval } from '@axlsdk/eval'` on a
 * real install throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * So this one installs the packed core + testing + eval into a sandbox and runs
 * a budgeted eval for real, asserting the two numbers a user actually reads:
 * the measured spend and the budget's terminal state.
 */
describe('Smoke: Packaged Runtime Contract', () => {
  it('runs a budgeted eval from the installed tarballs and reports measured spend', () => {
    const core = pack(join(ROOT, 'packages/axl'));
    const testing = pack(join(ROOT, 'packages/axl-testing'));
    const evalPkg = pack(join(ROOT, 'packages/axl-eval'));

    const sandbox = mkdtempSync(join(tmpdir(), 'axl-runtime-smoke-'));
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify(
        {
          name: 'axl-smoke-runner',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: {
            '@axlsdk/axl': `file:${core}`,
            '@axlsdk/testing': `file:${testing}`,
            '@axlsdk/eval': `file:${evalPkg}`,
            zod: '^4.0.0',
          },
        },
        null,
        2,
      ),
    );

    // Three cases at $0.30 against a $0.50 limit: the run must spend, then
    // close, and say so. A single case would not distinguish "budget honored"
    // from "budget ignored".
    writeFileSync(
      join(sandbox, 'run.mjs'),
      [
        "import { z } from 'zod';",
        "import { AxlRuntime, agent, workflow } from '@axlsdk/axl';",
        "import { MockProvider } from '@axlsdk/testing';",
        "import { dataset, scorer } from '@axlsdk/eval';",
        '',
        'const provider = MockProvider.sequence([',
        "  { content: 'a', cost: 0.3 },",
        "  { content: 'b', cost: 0.3 },",
        "  { content: 'c', cost: 0.3 },",
        ']);',
        'const runtime = new AxlRuntime({ trace: { enabled: false } });',
        "runtime.registerProvider('mock', provider);",
        "const bot = agent({ name: 'bot', model: 'mock:m', system: 's' });",
        'runtime.register(',
        '  workflow({',
        "    name: 'wf',",
        '    input: z.any(),',
        "    handler: async (ctx) => ctx.ask(bot, 'go'),",
        '  }),',
        ');',
        '',
        'const result = await runtime.eval({',
        "  workflow: 'wf',",
        '  dataset: dataset({',
        "    name: 'ds',",
        '    schema: z.object({ q: z.string() }),',
        "    items: [{ input: { q: '1' } }, { input: { q: '2' } }, { input: { q: '3' } }],",
        '  }),',
        "  scorers: [scorer({ name: 'pass', description: 'p', score: () => 1 })],",
        "  budget: '$0.50',",
        '});',
        '',
        'console.log(',
        '  JSON.stringify({',
        '    knownCost: result.accounting?.knownCost,',
        '    completeness: result.accounting?.completeness,',
        '    budget: result.accounting?.budget,',
        '  }),',
        ');',
        '',
      ].join('\n'),
    );

    execSync('npm install --no-audit --no-fund --loglevel=error', {
      cwd: sandbox,
      stdio: 'pipe',
      timeout: 90_000,
    });

    const stdout = execSync('node run.mjs', { cwd: sandbox, encoding: 'utf-8' });
    const report = JSON.parse(stdout.trim().split('\n').pop());

    // Measured, not declared: the provider reported $0.30 per call.
    expect(report.knownCost).toBeGreaterThan(0);
    expect(report.completeness).toBe('complete');
    // The budget closed, and the record says so rather than clamping the total.
    expect(report.budget.limit).toBe(0.5);
    expect(report.budget.status).toBe('closed');
    expect(report.budget.knownSpend).toBeCloseTo(report.knownCost, 10);
  }, 150_000);
});

/**
 * Optional-dependency loading in the ESM bundle.
 *
 * `SQLiteStore`, `SqliteVectorStore` and `RedisStore` load their optional
 * native deps with a synchronous `require()` — a sync constructor like
 * `new SQLiteStore(path)` cannot await a dynamic import. esbuild rewrites
 * those calls to its `__require` shim, which in an ESM output finds no
 * `require` binding and falls back to a Proxy that throws on call. Each
 * store caught that throw and reported it as a missing dependency, so every
 * ESM consumer saw "better-sqlite3 is required" / "redis is required" with
 * the package installed and resolvable. The CJS bundle was fine, and the
 * unit suite runs against TS source, so nothing caught it.
 *
 * These run the built ESM bundle the way a consumer imports it.
 */
describe('Smoke: ESM bundle optional dependencies', () => {
  const DIST = join(ROOT, 'packages/axl/dist/index.js');

  function runEsm(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'axl-esm-smoke-'));
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, body.replace('__DIST__', pathToFileURL(DIST).href));
    return execSync(`node ${script}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  }

  it('constructs the SQLite-backed stores from the ESM build', () => {
    const out = runEsm(
      [
        "import { SQLiteStore, SqliteVectorStore } from '__DIST__';",
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const dir = mkdtempSync(join(tmpdir(), 'axl-esm-db-'));",
        "const store = new SQLiteStore(join(dir, 'state.db'));",
        "const vectors = new SqliteVectorStore(join(dir, 'vectors.db'));",
        'store.close?.();',
        'vectors.close?.();',
        "console.log('constructed');",
      ].join('\n'),
    );
    expect(out).toBe('constructed');
  });

  it('loads the redis client from the ESM build, failing only on the connection', () => {
    // Port 1 is never a Redis server, so `create()` must reject — but on the
    // connection, having loaded the client. A rejection naming the dependency
    // is the bundler defect, not a missing package.
    const out = runEsm(
      [
        "import { RedisStore } from '__DIST__';",
        'try {',
        "  await RedisStore.create({ url: 'redis://127.0.0.1:1' });",
        "  console.log('connected-unexpectedly');",
        '} catch (err) {',
        '  console.log(err.message);',
        '}',
      ].join('\n'),
    );
    expect(out).not.toMatch(/redis is required for RedisStore/);
    expect(out).not.toMatch(/does not export createClient/);
  });
});
