/**
 * Shared CLI helpers for `@axlsdk/eval` and `@axlsdk/studio`. Hosted in core
 * so a fix to (e.g.) the tsx loader registration applies to both consumers
 * atomically — same anti-drift reasoning as `module-resolve.ts`.
 *
 * Not exported from the package index intentionally — these are loader-level
 * utilities, not part of the runtime/agent API. Consumers re-export the
 * pieces they need from their own `cli-utils` modules.
 *
 * @internal
 */

import { resolve, dirname, basename } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Config auto-detection ──────────────────────────────────────────

/**
 * Filenames searched (in order) when no `--config` is passed. Both `axl-eval`
 * and `axl-studio` walk this list — kept here so adding a new candidate
 * (e.g. `axl.config.cts`) takes effect everywhere.
 *
 * @internal
 */
export const CONFIG_CANDIDATES = [
  'axl.config.mts',
  'axl.config.ts',
  'axl.config.mjs',
  'axl.config.js',
];

/**
 * Find an `axl.config.*` file in `cwd`, returning the absolute path of the
 * first match in `CONFIG_CANDIDATES` order. Returns `undefined` if none exist.
 *
 * @internal
 */
export function findConfig(cwd: string): string | undefined {
  for (const name of CONFIG_CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ── Extension helpers ──────────────────────────────────────────────

/**
 * Returns true if the file is TypeScript and needs tsx to load.
 *
 * @internal
 */
export function needsTsxLoader(filePath: string): boolean {
  return /\.[mc]?tsx?$/.test(filePath);
}

// ── Module loading ────────────────────────────────────────────────

// Tracks whether we've already activated tsx's process-wide loader hooks.
// `undefined` = not yet attempted, `true` = ESM hook active (CJS hook is
// best-effort and tracked separately by tsx itself), `false` = tsx
// unavailable. Module-scoped so the second consumer (e.g. studio after
// eval) reuses eval's registration instead of attempting to re-register.
let tsxRegistered: boolean | undefined;

/**
 * Activate tsx's process-wide loader hooks once per Node process so any
 * subsequent `await import('./foo.ts')` AND any transitive `require('./foo.ts')`
 * from a CJS workspace dep are transformed.
 *
 * Why both hooks: tsx ships separate ESM (`tsx/esm/api`) and CJS
 * (`tsx/cjs/api`) hook APIs. The ESM hook intercepts `import()`. The CJS
 * hook patches `require.extensions` so `require('./x.ts')` from a CJS
 * package also gets transformed. tsx's own CLI registers both for the same
 * reason. Registering only ESM means a `.ts` eval file in a CJS-typed
 * package whose chain goes `import → cjs-pkg → require('./helper.ts')`
 * trips Node's `require(esm)` path (since the .ts has no CJS handler) and
 * fails with `ES Module ... cycle` / `Unknown file extension '.ts'`. The
 * ESM hook can't help — it doesn't see `require()` calls.
 *
 * Implementation note: tsx's `tsImport(specifier, parent)` uses a unique
 * namespace per call — it only transforms the entry import. Chained imports
 * MADE BY the entry file fall back to native Node ESM resolution, which
 * can't load `.ts` sources. That broke `--conditions development` whenever a
 * monorepo's `development` export pointed at `.ts` files. We instead call
 * `register()` (no namespace) once and rely on plain `await import()` for
 * each file — tsx then intercepts the entire ESM module graph for the
 * process lifetime.
 *
 * Process-wide registration is what tsx's own CLI does. Both hooks are
 * idempotent and only act on TypeScript-extension specifiers. ESM is the
 * critical hook (powers our entry-file `import()` below); CJS is
 * best-effort — if its API import fails on some unusual tsx build the ESM
 * hook still works, leaving callers in the pre-fix state for CJS chains
 * rather than worse. Falls back to false if tsx is not installed.
 *
 * @internal
 */
async function ensureTsxRegistered(): Promise<boolean> {
  if (tsxRegistered !== undefined) return tsxRegistered;
  try {
    // @ts-expect-error — tsx is an optional runtime dependency
    const esm = await import('tsx/esm/api');
    if (typeof esm.register !== 'function') {
      tsxRegistered = false;
      return tsxRegistered;
    }
    esm.register();
    tsxRegistered = true;
  } catch {
    tsxRegistered = false;
    return tsxRegistered;
  }
  try {
    // @ts-expect-error — tsx is an optional runtime dependency
    const cjs = await import('tsx/cjs/api');
    if (typeof cjs.register === 'function') {
      cjs.register();
    }
  } catch {
    // CJS api unavailable — `require('./x.ts')` chains from CJS workspace
    // deps will still trip require(esm) cycles (pre-fix behavior). Leave
    // tsxRegistered=true so the ESM-driven entry load proceeds.
  }
  return tsxRegistered;
}

/**
 * Import a module by file path, activating tsx's loader for `.ts`/`.tsx`
 * files. Throws an actionable error if tsx is needed but not installed —
 * preventing Node's cryptic `Unknown file extension '.ts'` from leaking
 * to the user.
 *
 * @internal
 */
export async function importModule(
  filePath: string,
  _parentURL?: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(filePath).href;
  if (!needsTsxLoader(filePath)) {
    return await import(url);
  }
  // For .ts/.tsx/.mts/.cts: try the import first. If the parent process
  // already registered tsx (e.g. `tsx watch src/cli.ts` for axl-studio
  // dev mode, or `tsx`-launched user scripts), the import succeeds with
  // no further work. Only fall back to ensureTsxRegistered when Node
  // surfaces the "no loader" signature — and only at that point require
  // tsx to be resolvable from this module's location.
  try {
    return await import(url);
  } catch (err) {
    if (!isMissingLoaderError(err)) throw err;
    const registered = await ensureTsxRegistered();
    if (!registered) {
      throw new Error(
        `Cannot load TypeScript file ${filePath}: tsx is not installed.\n` +
          `  tsx is declared by @axlsdk/eval / @axlsdk/studio so pnpm 8+ and npm 7+\n` +
          `  install it automatically. On Yarn Classic or with auto-install-peers\n` +
          `  disabled, install it explicitly: npm install -D tsx`,
      );
    }
    return await import(url);
  }
}

/** Detect Node's "this extension has no loader" error so we can decide
 *  whether to attempt tsx registration. Prefer Node's stable error codes
 *  over message-text matching where available — `ERR_UNKNOWN_FILE_EXTENSION`
 *  is the documented code for the ESM "no loader for .ts" path. The CJS
 *  branch (`Cannot use import statement outside a module`) is a SyntaxError
 *  with no documented code, so we still pattern-match its message there. */
function isMissingLoaderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION') return true;
  return /Cannot use import statement outside a module/i.test(err.message);
}

// ── Glob expansion ────────────────────────────────────────────────

const MAX_GLOB_DEPTH = 20;

/**
 * Minimal glob expander. Both axl-eval (CLI args) and axl-studio's
 * eval-loader (`evals: '...'` middleware option) walk this so a user gets
 * identical behavior whether they invoke the CLI or mount the middleware.
 *
 * Supported forms:
 * - `dir/*.eval.ts`     — match files in dir/
 * - `dir/.../*.eval.ts` — recursively match under dir/ (use `**\/*.eval.ts`)
 * - `**\/*.eval.ts`     — recursively match under cwd
 *
 * Multi-segment `**` (e.g. `a/**\/b/**\/*.ts`) is not supported — deliberate
 * scope limit; users with that need can pre-expand themselves.
 *
 * @internal
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  if (pattern.includes('**/')) {
    const sepIdx = pattern.indexOf('**/');
    const baseDir = resolve(cwd, pattern.slice(0, sepIdx) || '.');
    const fileGlob = pattern.slice(sepIdx + 3) || '*';
    return findFiles(baseDir, fileGlob, true);
  }
  const dir = resolve(cwd, dirname(pattern));
  const fileGlob = basename(pattern);
  return findFiles(dir, fileGlob, false);
}

function findFiles(dir: string, fileGlob: string, recursive: boolean, depth = 0): string[] {
  if (depth > MAX_GLOB_DEPTH) return [];
  const matcher = globToRegex(fileGlob);
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = resolve(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isFile() && matcher.test(entry)) {
          results.push(full);
        } else if (stat.isDirectory() && recursive) {
          results.push(...findFiles(full, fileGlob, true, depth + 1));
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Directory missing — return empty
  }
  return results;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ── Conditions ────────────────────────────────────────────────────

/**
 * Add custom Node.js import conditions process-wide via `module.register()`.
 * Used by `--conditions development` in monorepos whose package.json
 * `exports` use a `development` condition to point at `.ts` source instead
 * of built `dist`.
 *
 * Caveat: ESM-only. `node:module.register()` only installs ESM resolve
 * hooks; Node's CJS resolver never sees them. So when tsx compiles a
 * `.ts` file in a CJS-typed package, its `import` statements become
 * `require()` calls, those `require()`s use the CJS resolver, and the
 * extra conditions don't propagate — meaning a workspace package whose
 * `exports.development → "./src/foo.ts"` resolves to the `default`
 * entry (e.g. built `./dist/foo.js`) instead of the `.ts` source. This
 * is independent of the `tsx/cjs/api` hook (which fixes `.ts` *file
 * loading* under require, but can't make the CJS resolver consult ESM
 * conditions). Workaround for full condition coverage: add
 * `"type": "module"` to the importer's package, or rename it to `.mts`,
 * so its internal imports stay as `import` and hit the ESM resolve hook.
 *
 * @internal
 */
export async function registerConditions(conditions: string[]): Promise<void> {
  try {
    const nodeModule = await import('node:module');
    const hookCode = [
      `const extra = ${JSON.stringify(conditions)};`,
      `export async function resolve(specifier, context, nextResolve) {`,
      `  return nextResolve(specifier, {`,
      `    ...context,`,
      `    conditions: [...new Set([...context.conditions, ...extra])],`,
      `  });`,
      `}`,
    ].join('\n');
    nodeModule.register(`data:text/javascript,${encodeURIComponent(hookCode)}`);
  } catch {
    console.warn('Warning: this Node.js runtime does not support --conditions');
  }
}
