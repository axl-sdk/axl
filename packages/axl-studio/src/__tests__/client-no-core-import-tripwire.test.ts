/**
 * Tripwire test: no file under `packages/axl-studio/src/client/` may import
 * VALUES from `@axlsdk/axl` (the core package). Type-only imports are
 * permitted (and encouraged) because they are erased at compile time.
 *
 * Background: `@axlsdk/axl` uses Node's `AsyncLocalStorage` (`node:async_hooks`)
 * for ALS-backed ask correlation. Vite externalizes `async_hooks` with a
 * runtime-error stub (`Module 'async_hooks' has been externalized for browser
 * compatibility`), so any client module that pulls a VALUE in from the core
 * package crashes the SPA on first load.
 *
 * Why type-only imports are safe: `tsconfig.base.json` enables both
 * `verbatimModuleSyntax: true` and `isolatedModules: true`. With
 * `verbatimModuleSyntax`, the TypeScript compiler GUARANTEES that `import type`
 * (and `export type`) declarations are fully erased — they never appear in the
 * emitted JS, so they can't pull a runtime module into the bundle. This holds
 * for both the tsup server build and the Vite client build (Vite delegates
 * type stripping to esbuild, which honors `verbatimModuleSyntax`).
 *
 * What's still banned:
 *   - Value imports: `import { x } from '@axlsdk/axl'`
 *   - Mixed value/type imports: `import { type X, y } from '@axlsdk/axl'`
 *     (the `y` value is still emitted, regardless of `verbatimModuleSyntax`)
 *   - Side-effect imports: `import '@axlsdk/axl'`
 *   - Default imports: `import core from '@axlsdk/axl'` (default re-export
 *     would still be a runtime binding)
 *   - Dynamic imports: `import('@axlsdk/axl')` and
 *     `await import('@axlsdk/axl')` (these resolve at runtime and have the
 *     same `async_hooks` crash profile as static value imports)
 *
 * What's allowed:
 *   - `import type { X } from '@axlsdk/axl'`
 *   - `export type { X } from '@axlsdk/axl'`
 *
 * If a client file needs an SDK runtime helper, duplicate it into
 * `src/client/lib/` (see `src/client/lib/event-utils.ts` for the pattern).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLIENT_ROOT = resolve(__dirname, '../client');

/** Recursively collect all .ts / .tsx files under `dir`. */
function walkClientFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkClientFiles(full, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

// Match value-bearing `import` / `export` statements that target `@axlsdk/axl`.
// We exclude `import type` and `export type` (fully erased under
// `verbatimModuleSyntax: true`) by requiring that the keyword `type` does NOT
// follow `import`/`export`. A negative lookahead on `\s+type\b` keeps "import"
// in `imports` (an identifier prefix) from accidentally matching.
//
// Mixed imports — `import { type X, y } from '...'` — DO match here because
// the `y` value binding is still emitted at runtime, regardless of the inline
// `type` modifier on `X`. Authors should split into separate `import type`
// and `import` statements (the latter must not target `@axlsdk/axl`).
const valueImportRe =
  /(?:^|\n)\s*import(?!\s+type\b)\s+(?:[\s\S]+?)\s+from\s+['"]@axlsdk\/axl(?:\/[^'"]*)?['"]/;
const valueReExportRe =
  /(?:^|\n)\s*export(?!\s+type\b)\s+(?:[\s\S]+?)\s+from\s+['"]@axlsdk\/axl(?:\/[^'"]*)?['"]/;
// Side-effect imports — `import '@axlsdk/axl'` — execute the module for its
// side effects. Always forbidden.
const sideEffectImportRe = /(?:^|\n)\s*import\s+['"]@axlsdk\/axl(?:\/[^'"]*)?['"]/;
// Dynamic imports — `import('@axlsdk/axl')` / `await import('@axlsdk/axl')` —
// resolve the module at runtime and pull `async_hooks` into the SPA bundle
// just like a static value import. Easy to reach for as a tripwire bypass;
// must be banned.
const dynamicImportRe = /\bimport\s*\(\s*['"]@axlsdk\/axl(?:\/[^'"]*)?['"]\s*\)/;

describe('client-no-core-import tripwire', () => {
  const files = walkClientFiles(CLIENT_ROOT);

  it('finds at least one client file (sanity check the walker)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(CLIENT_ROOT.length + 1);
    it(`${rel} does not import VALUES from '@axlsdk/axl'`, () => {
      const raw = readFileSync(file, 'utf-8');
      // Strip comments first so commented-out imports don't trigger.
      const codeWithStrings = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(
        valueImportRe.test(codeWithStrings),
        `${rel} has a value-bearing import from '@axlsdk/axl', which transitively pulls in ` +
          `node:async_hooks and crashes the Vite-bundled SPA on first load. ` +
          `Use 'import type { … }' for type-only access (safe under verbatimModuleSyntax), ` +
          `or mirror the runtime helper into src/client/lib/ — see ` +
          `src/client/lib/event-utils.ts for the established pattern.`,
      ).toBe(false);
      expect(
        valueReExportRe.test(codeWithStrings),
        `${rel} has a value-bearing re-export from '@axlsdk/axl' (use 'export type { … }' instead).`,
      ).toBe(false);
      expect(
        sideEffectImportRe.test(codeWithStrings),
        `${rel} has a side-effect import of '@axlsdk/axl' — same crash risk as a named import.`,
      ).toBe(false);
      expect(
        dynamicImportRe.test(codeWithStrings),
        `${rel} has a dynamic import of '@axlsdk/axl' — resolves at runtime and pulls in ` +
          `node:async_hooks just like a static value import.`,
      ).toBe(false);
    });
  }

  // Contract pinning: synthetic fixtures verify the regex behavior so the
  // "type-only is safe, value is banned, mixed is banned" boundary doesn't
  // drift as the regex evolves.
  describe('regex contract', () => {
    const allowed = [
      `import type { AxlEvent } from '@axlsdk/axl';`,
      `import type { AxlEvent, AxlEventOf } from '@axlsdk/axl';`,
      `export type { AxlEvent } from '@axlsdk/axl';`,
      `// import { x } from '@axlsdk/axl'; // commented out`,
    ];
    const banned = [
      `import { eventCostContribution } from '@axlsdk/axl';`,
      `import core from '@axlsdk/axl';`,
      `import { type AxlEvent, eventCostContribution } from '@axlsdk/axl';`,
      `import '@axlsdk/axl';`,
      `export { eventCostContribution } from '@axlsdk/axl';`,
      `const m = await import('@axlsdk/axl');`,
      `const m = import('@axlsdk/axl');`,
      `void import('@axlsdk/axl');`,
    ];

    for (const src of allowed) {
      it(`allows: ${src.slice(0, 60)}`, () => {
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(valueImportRe.test(stripped)).toBe(false);
        expect(valueReExportRe.test(stripped)).toBe(false);
        expect(sideEffectImportRe.test(stripped)).toBe(false);
        expect(dynamicImportRe.test(stripped)).toBe(false);
      });
    }

    for (const src of banned) {
      it(`bans: ${src.slice(0, 60)}`, () => {
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const flagged =
          valueImportRe.test(stripped) ||
          valueReExportRe.test(stripped) ||
          sideEffectImportRe.test(stripped) ||
          dynamicImportRe.test(stripped);
        expect(flagged).toBe(true);
      });
    }
  });
});
