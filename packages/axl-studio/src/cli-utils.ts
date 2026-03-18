import { resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';

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
}

export function parseArgs(argv: string[]): CliArgs {
  let port = 4400;
  let config: string | undefined;
  let open = false;
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
    }
  }

  return { port, config, open, conditions };
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

/**
 * Returns true if the config path is a TypeScript file that needs tsx loader hooks.
 */
export function needsTsxLoader(configPath: string): boolean {
  return /\.[mc]?tsx?$/.test(configPath);
}
