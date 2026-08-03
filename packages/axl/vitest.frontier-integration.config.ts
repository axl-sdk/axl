import { defineConfig } from 'vitest/config';
import { loadLiveIntegrationEnv } from './vitest.live-env.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: loadLiveIntegrationEnv(),
    include: ['src/__tests__/integration-latest-models.test.ts'],
    testTimeout: 180_000,
  },
});
