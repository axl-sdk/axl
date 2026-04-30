/**
 * CLI utilities for `axl-studio`.
 *
 * Loader / glob / config-detection helpers now live in `@axlsdk/axl`'s
 * `cli-internals` (shared with `@axlsdk/eval` so fixes apply atomically);
 * this file holds the studio-specific arg parser and re-exports what
 * dependent modules consume.
 */

export { CONFIG_CANDIDATES, findConfig, needsTsxLoader, importModule } from '@axlsdk/axl';

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
