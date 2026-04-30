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

// ── Parse CLI args ──────────────────────────────────────────────────

export interface CliArgs {
  port: number;
  config?: string;
  open: boolean;
  conditions: string[];
  readOnly: boolean;
  help: boolean;
  portError?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let port = 4400;
  let config: string | undefined;
  let open = false;
  let help = false;
  let conditions: string[] = [];
  let readOnly = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--config' && argv[i + 1]) {
      config = argv[i + 1];
      i++;
    } else if (arg === '--conditions' && argv[i + 1]) {
      conditions = argv[i + 1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      i++;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--read-only' || arg === '--readonly') {
      readOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    }
  }

  const result: CliArgs = { port, config, open, help, conditions, readOnly };

  if (isNaN(port) || port < 1 || port > 65535) {
    result.portError = `Invalid port: ${port}. Must be between 1 and 65535.`;
  }

  return result;
}

// ── Extension helpers ──────────────────────────────────────────────

/**
 * Returns true if the file is TypeScript and needs tsx to load.
 */
export function needsTsxLoader(configPath: string): boolean {
  return /\.[mc]?tsx?$/.test(configPath);
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
