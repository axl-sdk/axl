import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/server/index.ts', 'src/middleware.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { outDir: '.dts-tmp' } },
  clean: false, // Don't clean dist/ — vite build:client outputs to dist/client/ first
  sourcemap: true,
  external: ['react', 'react-dom'],
});
