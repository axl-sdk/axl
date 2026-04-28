import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        "import type { AxlEvent, AxlEventOf, AskScoped } from '@axlsdk/axl';",
        '',
        'export function inspect(ev: AxlEvent): void {',
        '  switch (ev.type) {',
        "    case 'agent_call_end': {",
        '      // cost is a required number on agent_call_end',
        '      const _cost: number = ev.cost;',
        '      void _cost;',
        '      break;',
        '    }',
        "    case 'tool_call_end': {",
        '      // tool is a required string on tool_call_end',
        '      const _tool: string = ev.tool;',
        '      void _tool;',
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
        '// AxlEventOf extracts a single variant — pin a known numeric field on it',
        "// to catch a regression where the helper or the variant's `cost` drops.",
        "export function readAgentCallCost(ev: AxlEventOf<'agent_call_end'>): number {",
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
