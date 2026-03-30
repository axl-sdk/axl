import { resolve, relative, dirname, basename } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AxlRuntime } from '@axlsdk/axl';
import { importModule } from './cli-utils.js';

// In the CJS bundle, tsup stubs import.meta as {} so import.meta.url is
// undefined. Fall back to __filename (which CJS defines) converted to a
// file:// URL so tsImport() gets a valid parentURL.
const parentURL: string =
  import.meta.url ?? pathToFileURL(typeof __filename !== 'undefined' ? __filename : __dirname).href;

/**
 * Configuration for lazy eval file discovery.
 *
 * - `string` — a glob pattern or explicit file path
 * - `string[]` — multiple patterns/paths
 * - `object` — patterns with optional import conditions
 */
export type EvalLoaderConfig =
  | string
  | string[]
  | {
      files: string | string[];

      /**
       * Custom Node.js import conditions (e.g., `['development']`).
       *
       * In monorepos, package.json `exports` often use the `development` condition
       * to point at source (`.ts`) instead of built dist. Without this, eval files
       * that import workspace packages resolve to dist files, which may not exist.
       *
       * **WARNING**: Conditions are registered process-wide via `module.register()`.
       * They affect all subsequent imports in the process, not just eval files.
       */
      conditions?: string[];
    };

/**
 * Create a lazy eval loader that resolves file patterns and dynamically imports
 * eval files on first call, registering them with the runtime.
 *
 * The loader is idempotent — subsequent calls return the same promise.
 * Concurrent callers all await the same loading work.
 *
 * Eval files should export a default config with `{ workflow, dataset, scorers }`
 * (the result of `defineEval()` from `@axlsdk/eval`). An optional named export
 * `executeWorkflow` overrides the default `runtime.execute()` behavior.
 *
 * Eval names are the file's path relative to `cwd` (project root), minus the
 * `.eval.*` suffix. This makes names completely stable — a file's name never
 * changes regardless of what other files or patterns exist.
 *
 * @param config  Glob patterns, file paths, or object with conditions
 * @param runtime The AxlRuntime to register discovered evals on
 * @param cwd     Base directory for resolving patterns and deriving names (default: `process.cwd()`)
 */
export function createEvalLoader(
  config: EvalLoaderConfig,
  runtime: AxlRuntime,
  cwd?: string,
): () => Promise<void> {
  let loadPromise: Promise<void> | undefined;
  const { patterns, conditions } = normalizeConfig(config);
  const baseCwd = cwd ?? process.cwd();

  return () => {
    if (!loadPromise) {
      loadPromise = loadEvalFiles(patterns, conditions, baseCwd, runtime).catch((err) => {
        loadPromise = undefined; // Allow retry on next request
        throw err;
      });
    }
    return loadPromise;
  };
}

// ── Core loading logic ─────────────────────────────────────────────

async function loadEvalFiles(
  patterns: string[],
  conditions: string[],
  cwd: string,
  runtime: AxlRuntime,
): Promise<void> {
  if (conditions.length > 0) {
    await registerConditions(conditions);
  }

  const files = resolvePatterns(patterns, cwd);

  if (files.length === 0) {
    console.warn(`[axl-studio] No eval files found matching: ${patterns.join(', ')}`);
    return;
  }

  for (const file of files) {
    try {
      const mod = await importModule(file, parentURL);
      const evalConfig = mod.default?.default ?? mod.default ?? mod.config ?? mod;

      if (!evalConfig.workflow || !evalConfig.dataset || !evalConfig.scorers) {
        console.warn(
          `[axl-studio] Skipping ${file}: not a valid eval config ` +
            `(missing workflow, dataset, or scorers)`,
        );
        continue;
      }

      const name = deriveEvalName(file, cwd);

      if (runtime.getRegisteredEval(name)) {
        console.warn(
          `[axl-studio] Eval name "${name}" from ${file} collides with an ` +
            `already-registered eval — overwriting`,
        );
      }

      runtime.registerEval(name, evalConfig, mod.executeWorkflow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[axl-studio] Failed to load eval ${file}: ${msg}`);
    }
  }
}

// ── Internal helpers ───────────────────────────────────────────────

function normalizeConfig(config: EvalLoaderConfig): {
  patterns: string[];
  conditions: string[];
} {
  if (typeof config === 'string') {
    return { patterns: [config], conditions: [] };
  }
  if (Array.isArray(config)) {
    return { patterns: config, conditions: [] };
  }
  const files = typeof config.files === 'string' ? [config.files] : config.files;
  return { patterns: files, conditions: config.conditions ?? [] };
}

/**
 * Derive eval name from file path relative to cwd.
 *
 * Examples (cwd = `/project`):
 * - `/project/evals/suggestions.eval.ts` → `"evals/suggestions"`
 * - `/project/evals/api/accuracy.eval.ts` → `"evals/api/accuracy"`
 */
function deriveEvalName(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  // Normalize to forward slashes for cross-platform consistency
  const normalized = rel.replace(/\\/g, '/');
  // Guard: file outside cwd (symlink, absolute path) — fall back to basename
  if (normalized.startsWith('../')) {
    const base = basename(filePath);
    const stripped = base.replace(/\.eval\.[mc]?[jt]sx?$/, '');
    return stripped !== base ? stripped : base.replace(/\.[mc]?[jt]sx?$/, '') || base;
  }
  // Strip .eval.ts, .eval.mjs, .eval.js, etc.
  const withoutEval = normalized.replace(/\.eval\.[mc]?[jt]sx?$/, '');
  if (withoutEval !== normalized) return withoutEval;
  // Fallback: strip extension
  const withoutExt = normalized.replace(/\.[mc]?[jt]sx?$/, '');
  return withoutExt || normalized;
}

/**
 * Resolve patterns to absolute file paths.
 *
 * Supports:
 * - Explicit file paths (no wildcards)
 * - Single-directory globs: `dir/*.eval.ts`
 * - Recursive globs: `dir/**\/*.eval.ts` or `**\/*.eval.ts`
 *
 * Multi-segment `**` (e.g., `a/**\/b/**\/*.ts`) is not supported.
 */
function resolvePatterns(patterns: string[], cwd: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const resolved = pattern.includes('*') ? expandGlob(pattern, cwd) : [resolve(cwd, pattern)];
    for (const file of resolved) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * Expand a glob pattern to matching file paths.
 *
 * Supported forms:
 * - `dir/*.eval.ts`     — match files in dir/
 * - `dir/**\/*.eval.ts` — recursively match under dir/
 * - `**\/*.eval.ts`     — recursively match under cwd
 */
function expandGlob(pattern: string, cwd: string): string[] {
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

const MAX_DEPTH = 20;

function findFiles(dir: string, fileGlob: string, recursive: boolean, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
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
    // Directory doesn't exist or unreadable
  }

  return results;
}

/** Convert a simple glob pattern (e.g., `*.eval.ts`) to a RegExp. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function registerConditions(conditions: string[]): Promise<void> {
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
    console.warn('[axl-studio] Warning: import conditions require Node.js 20.6+');
  }
}
