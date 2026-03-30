/**
 * CLI utilities for config detection, runtime resolution, and loader registration.
 *
 * These are duplicated from @axlsdk/studio (cli-utils.ts, resolve-runtime.ts,
 * eval-loader.ts, cli.ts) because @axlsdk/eval cannot depend on @axlsdk/studio.
 * Keep in sync with the studio versions if either changes.
 */

import { resolve, extname } from 'node:path';
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

/**
 * Returns true if the config path has an ambiguous TypeScript extension (.ts/.tsx)
 * that needs ESM forcing. Explicit extensions (.mts/.cts) are excluded.
 */
export function needsEsmForcing(configPath: string): boolean {
  const ext = extname(configPath);
  return ext === '.ts' || ext === '.tsx';
}

/** Returns true if the config path is a TypeScript file that needs tsx loader hooks. */
export function needsTsxLoader(configPath: string): boolean {
  return /\.[mc]?tsx?$/.test(configPath);
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
export function resolveRuntime(mod: Record<string, unknown>): unknown {
  const def = mod.default as Record<string, unknown> | undefined;
  return def?.default ?? def ?? mod.runtime;
}

// ── Loader registration ────────────────────────────────────────────

let tsxRegistered = false;

export async function ensureTsxLoader(): Promise<void> {
  if (tsxRegistered) return;
  tsxRegistered = true;

  let loaded = false;
  try {
    // @ts-expect-error — tsx is an optional runtime dependency
    const tsxEsm = await import('tsx/esm/api');
    tsxEsm.register();
    loaded = true;
  } catch {
    // ESM hook not available
  }
  try {
    // @ts-expect-error — tsx is an optional runtime dependency
    const tsxCjs = await import('tsx/cjs/api');
    tsxCjs.register();
    loaded = true;
  } catch {
    // CJS hook not available
  }
  if (!loaded) {
    console.warn(
      '[axl-eval] Warning: tsx is not installed. TypeScript files require tsx.\n' +
        '  Install it with: npm install -D tsx',
    );
  }
}

/**
 * Force ESM format for a specific config file so top-level await works
 * regardless of the nearest package.json "type" field.
 */
export async function forceEsmForConfig(configPath: string): Promise<void> {
  try {
    const nodeModule = await import('node:module');
    const configUrl = pathToFileURL(configPath).href;
    const hookCode = [
      `export async function resolve(specifier, context, nextResolve) {`,
      `  const result = await nextResolve(specifier, context);`,
      `  if (result.url === ${JSON.stringify(configUrl)}) result.format = 'module';`,
      `  return result;`,
      `}`,
    ].join('\n');
    nodeModule.register(`data:text/javascript,${encodeURIComponent(hookCode)}`);
  } catch {
    // module.register() not available (Node < 20.6)
  }
}

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
