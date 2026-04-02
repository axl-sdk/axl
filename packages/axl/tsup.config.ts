import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // @axlsdk/eval is dynamically imported at runtime (optional) — never bundle it
  external: ['@axlsdk/eval'],
});
