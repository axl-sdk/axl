import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, 'src/client'),
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 4401,
    proxy: {
      '/api': 'http://127.0.0.1:4400',
      '/ws': {
        target: 'ws://127.0.0.1:4400',
        ws: true,
      },
    },
  },
});
