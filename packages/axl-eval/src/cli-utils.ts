/**
 * CLI utilities for config detection, runtime resolution, and loader registration.
 *
 * Module-resolution helpers (`resolveRuntime`, `pickDefault`, `pickExport`)
 * live in `@axlsdk/axl` so the eval CLI and Studio middleware share one
 * implementation of the ESM/CJS interop walk. Re-exported here so existing
 * imports from `./cli-utils` keep working.
 *
 * The remaining helpers (config detection, tsx loader registration, glob
 * expansion) duplicate equivalents in `@axlsdk/studio/cli-utils`. Studio
 * cannot import from this package and vice versa; keeping these aligned is
 * a manual discipline.
 */

import { resolve, dirname, basename } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export { resolveRuntime, pickDefault, pickExport } from '@axlsdk/axl';

// ── Config auto-detection ──────────────────────────────────────────

export const CONFIG_CANDIDATES = [
  'axl.config.mts',
  'axl.config.ts',
  'axl.config.mjs',
  'axl.config.js',
];

export function findConfig(cwd: string): string | undefined {
  for (const name of CONFIG_CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ── Extension helpers ──────────────────────────────────────────────

/** Returns true if the file is TypeScript and needs tsx to load. */
export function needsTsxLoader(filePath: string): boolean {
  return /\.[mc]?tsx?$/.test(filePath);
}

// ── Module loading ────────────────────────────────────────────────

// Tracks whether we've already activated tsx's process-wide ESM loader hooks.
// `undefined` = not yet attempted, `true` = active, `false` = tsx unavailable.
let tsxRegistered: boolean | undefined;

/**
 * Import a module, activating tsx's loader hooks process-wide for TypeScript
 * files so chained imports (workspace `.ts` sources resolved via custom
 * conditions, transitive imports between TS files) are transformed too.
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
 * Process-wide registration is what tsx's own CLI does. The hook is
 * idempotent and only acts on TypeScript-extension specifiers. Falls back
 * to regular `import()` if tsx is not installed.
 */
async function ensureTsxRegistered(): Promise<boolean> {
  if (tsxRegistered !== undefined) return tsxRegistered;
  try {
    // @ts-expect-error — tsx is an optional runtime dependency
    const mod = await import('tsx/esm/api');
    if (typeof mod.register === 'function') {
      mod.register();
      tsxRegistered = true;
    } else {
      tsxRegistered = false;
    }
  } catch {
    tsxRegistered = false;
  }
  return tsxRegistered;
}

export async function importModule(
  filePath: string,
  _parentURL: string,
): Promise<Record<string, any>> {
  if (needsTsxLoader(filePath)) {
    const registered = await ensureTsxRegistered();
    if (!registered) {
      // Pre-check: don't let the subsequent `await import()` throw Node's
      // cryptic "Unknown file extension '.ts'" error. Surface a clean,
      // actionable message instead. Throw rather than warn — the caller
      // can't proceed without TS support.
      throw new Error(
        `Cannot load TypeScript file ${filePath}: tsx is not installed.\n` +
          `  Install it as a dev dependency: npm install -D tsx (or pnpm add -D tsx)`,
      );
    }
  }
  return await import(pathToFileURL(filePath).href);
}

// ── Glob expansion ────────────────────────────────────────────────

/**
 * Minimal glob expander matching studio's eval-loader semantics so users get
 * the same behavior whether they run `axl-eval` or load files via the studio
 * middleware. Without this, CLI users on Windows (or with quoted patterns
 * the shell didn't expand) hit confusing "file not found" errors.
 *
 * Supported forms:
 * - `dir/*.eval.ts`     — match files in dir/
 * - `dir/**\/*.eval.ts` — recursively match under dir/
 * - `**\/*.eval.ts`     — recursively match under cwd
 *
 * Multi-segment `**` (e.g. `a/**\/b/**\/*.ts`) is not supported — deliberate
 * scope limit; users with that need can pre-expand themselves.
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

const MAX_GLOB_DEPTH = 20;

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
    console.warn('[axl-eval] Warning: --conditions requires Node.js 20.6+');
  }
}
