import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Load the repository-root .env for opt-in live provider suites. */
export function loadLiveIntegrationEnv(): Record<string, string> {
  try {
    const content = readFileSync(resolve(workspaceRoot, '.env'), 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const stripped = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
      const eqIndex = stripped.indexOf('=');
      if (eqIndex === -1) continue;
      env[stripped.slice(0, eqIndex)] = stripped.slice(eqIndex + 1);
    }
    return env;
  } catch {
    return {};
  }
}
