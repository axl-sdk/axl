import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { outDir: '.dts-tmp' } },
  clean: true,
  sourcemap: true,
});
