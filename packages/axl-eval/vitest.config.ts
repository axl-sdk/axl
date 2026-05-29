import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests hit live provider APIs and require keys — they run only
    // via `pnpm test:integration` (vitest.integration.config.ts), never in the
    // default unit run. Without this exclude, `pnpm test` on a machine with API
    // keys exported would silently spend money.
    exclude: ['src/__tests__/integration*.test.ts', 'node_modules/**'],
  },
});
