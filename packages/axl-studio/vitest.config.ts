import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild handles .tsx via tsconfig's `jsx: 'react-jsx'`; no React plugin needed
  // for tests (Fast Refresh / HMR are dev-server concerns). Component tests opt
  // into jsdom via a per-file `// @vitest-environment jsdom` directive.
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
    setupFiles: ['src/__tests__/setup-dom.ts'],
  },
});
