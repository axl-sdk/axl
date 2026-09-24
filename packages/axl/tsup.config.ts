import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { outDir: '.dts-tmp' } },
  clean: true,
  sourcemap: true,
  // @axlsdk/eval is dynamically imported at runtime (optional) — never bundle it
  external: ['@axlsdk/eval'],
  esbuildOptions(options, context) {
    // The optional native deps (`better-sqlite3`, `redis`) load through a
    // synchronous `require()` — a sync constructor like `new SQLiteStore(path)`
    // can't await a dynamic import. esbuild rewrites those calls to its own
    // `__require` shim, which in an ESM output finds no `require` binding and
    // falls back to a Proxy that throws on call. The stores caught that throw
    // and reported it as a missing dependency, so every ESM consumer saw
    // "better-sqlite3 is required" / "redis is required" no matter what was
    // installed. Defining `require` here gives the shim the real thing.
    // CJS already has `require`, and re-declaring it there is a syntax error.
    if (context.format === 'esm') {
      options.banner = {
        js: [
          "import { createRequire as __axlCreateRequire } from 'node:module';",
          'const require = __axlCreateRequire(import.meta.url);',
        ].join('\n'),
      };
    }
  },
});
