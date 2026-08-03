import { defineConfig } from 'vitest/config';
import { loadLiveIntegrationEnv } from './vitest.live-env.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: loadLiveIntegrationEnv(),
    include: ['src/__tests__/integration*.test.ts'],
    exclude: ['src/__tests__/integration-latest-models.test.ts'],
    // Live API calls — reasoning models, schema-retry loops, and slow providers
    // routinely exceed Vitest's 5s default. Give each test room.
    testTimeout: 60_000,
  },
});
