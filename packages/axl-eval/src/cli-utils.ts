/**
 * CLI utilities for config detection, runtime resolution, and loader registration.
 *
 * These are duplicated from @axlsdk/studio (cli-utils.ts, resolve-runtime.ts,
 * eval-loader.ts, cli.ts) because @axlsdk/eval cannot depend on @axlsdk/studio.
 * Keep in sync with the studio versions if either changes.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

// ── Runtime resolution ─────────────────────────────────────────────

/**
 * Resolve the AxlRuntime from a dynamically imported config module.
 *
 * Module shapes handled:
 * - ESM `export default runtime` → mod.default is the runtime
 * - CJS compiled from `export default runtime` → mod.default.default is the runtime
 * - CJS `module.exports = runtime` → mod.default is the runtime
 * - Named `export { runtime }` → mod.runtime is the runtime
 */
export function resolveRuntime(mod: Record<string, any>): unknown {
  const def = mod.default as Record<string, any> | undefined;
  return def?.default ?? def ?? mod.runtime;
}

// ── Module loading ────────────────────────────────────────────────

// Lazily resolved tsImport function from tsx. `undefined` = not yet checked,
// `null` = tsx not available.
let tsImportFn:
  | ((specifier: string, parentURL: string) => Promise<Record<string, any>>)
  | null
  | undefined;

/**
 * Import a module, using tsx's `tsImport()` for TypeScript files.
 *
 * `tsImport()` handles ESM/CJS format correctly without process-wide side effects —
 * no need for `register()` hooks or ESM-forcing workarounds. Falls back to regular
 * `import()` for non-TypeScript files or when tsx is not installed.
 */
export async function importModule(
  filePath: string,
  parentURL: string,
): Promise<Record<string, any>> {
  if (needsTsxLoader(filePath)) {
    if (tsImportFn === undefined) {
      try {
        // @ts-expect-error — tsx is an optional runtime dependency
        const mod = await import('tsx/esm/api');
        tsImportFn = mod.tsImport ?? null;
      } catch {
        tsImportFn = null;
        console.warn(
          '[axl-eval] Warning: tsx is not installed. TypeScript files require tsx.\n' +
            '  Install it with: npm install -D tsx',
        );
      }
    }
    if (tsImportFn) {
      return (await tsImportFn(pathToFileURL(filePath).href, parentURL)) as Record<string, any>;
    }
  }
  return await import(pathToFileURL(filePath).href);
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
