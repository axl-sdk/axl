/**
 * Tripwire test: no file under `packages/axl-studio/src/client/` may import
 * from `@axlsdk/axl` (the core package).
 *
 * Background: `@axlsdk/axl` uses Node's `AsyncLocalStorage` (`node:async_hooks`)
 * for ALS-backed ask correlation. Vite externalizes `async_hooks` with a
 * runtime-error stub (`Module 'async_hooks' has been externalized for browser
 * compatibility`), so any client module that pulls in the core package crashes
 * the SPA on first load.
 *
 * This was a real bug caught only via manual Chrome testing during the spec/16
 * verification pass — the unit tests all run in jsdom (Node), where the import
 * succeeds. The fix was a client-local mirror at
 * `src/client/lib/event-utils.ts` (and a loose `AxlEvent` type alias at
 * `src/client/lib/types.ts`) so the client never reaches into the core barrel.
 *
 * If this tripwire fails: either revert the import, or — if the new code
 * really needs a SDK helper — duplicate the helper into `src/client/lib/`
 * the same way `eventCostContribution` was mirrored, and document the
 * duplication's why-not-import reason.
 *
 * Type-only imports (`import type { … } from '@axlsdk/axl'`) would normally
 * be erased by the bundler and safe — but `vite` + `tsx` interop has been
 * inconsistent on this; we ban them too to remove the foot-gun entirely.
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

describe('client-no-core-import tripwire', () => {
  const files = walkClientFiles(CLIENT_ROOT);

  it('finds at least one client file (sanity check the walker)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Match `from '@axlsdk/axl'` and `from '@axlsdk/axl/...'` (subpaths). After
  // stripNonCode, the path is reduced to '' or '@axlsdk/axl', so we match on
  // the literal `'@axlsdk/axl'` segment that survives normalization.
  // Real strings collapse to '' before this regex runs, but ES module specifiers
  // in `import …from '…'` survive because we strip strings AFTER comments — and
  // the specifier IS a string. So we need to scan the raw source for the
  // import statement itself, not the stripped form.
  const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]+?)\s+from\s+['"]@axlsdk\/axl(?:\/[^'"]*)?['"]/;
  const sideEffectImportRe = /(?:^|\n)\s*import\s+['"]@axlsdk\/axl(?:\/[^'"]*)?['"]/;

  for (const file of files) {
    const rel = file.slice(CLIENT_ROOT.length + 1);
    it(`${rel} does not import from '@axlsdk/axl'`, () => {
      const raw = readFileSync(file, 'utf-8');
      // Strip comments first so commented-out imports don't trigger.
      const codeWithStrings = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(
        importRe.test(codeWithStrings),
        `${rel} imports from '@axlsdk/axl', which transitively pulls in node:async_hooks ` +
          `and crashes the Vite-bundled SPA on first load. ` +
          `Mirror the helper into src/client/lib/ instead — see ` +
          `src/client/lib/event-utils.ts for the established pattern.`,
      ).toBe(false);
      expect(
        sideEffectImportRe.test(codeWithStrings),
        `${rel} has a side-effect import of '@axlsdk/axl' — same crash risk as a named import.`,
      ).toBe(false);
    });
  }
});
