import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, 'src/client'),
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 4401,
    proxy: {
      '/api': 'http://localhost:4400',
      '/ws': {
        target: 'ws://localhost:4400',
        ws: true,
      },
    },
  },
});
