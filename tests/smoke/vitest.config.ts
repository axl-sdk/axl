import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: import.meta.dirname,
    include: ['smoke.test.ts'],
    testTimeout: 60_000,
  },
});
