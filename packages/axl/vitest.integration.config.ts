import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function loadDotEnv(dir: string): Record<string, string> {
  try {
    const content = readFileSync(resolve(dir, '.env'), 'utf-8');
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

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: loadDotEnv(root),
    include: ['src/__tests__/integration*.test.ts'],
    // Live API calls — reasoning models, schema-retry loops, and slow providers
    // routinely exceed Vitest's 5s default. Give each test room.
    testTimeout: 60_000,
  },
});
