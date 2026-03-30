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
  help: boolean;
  portError?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let port = 4400;
  let config: string | undefined;
  let open = false;
  let help = false;
  let conditions: string[] = [];

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
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    }
  }

  const result: CliArgs = { port, config, open, help, conditions };

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
        const mod = await import('tsx/esm/api');
        tsImportFn = mod.tsImport ?? null;
      } catch {
        tsImportFn = null;
        console.warn(
          '[axl-studio] Warning: tsx is not installed. TypeScript config files require tsx as a dependency.\n' +
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
