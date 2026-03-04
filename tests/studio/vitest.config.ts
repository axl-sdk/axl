import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: import.meta.dirname,
    include: ['api/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
