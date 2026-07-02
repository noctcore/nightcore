import { fileURLToPath, URL } from 'node:url';

import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  // Relative base so built assets resolve under Tauri's custom protocol.
  base: './',
  plugins: [react(), tailwind()],
  // Tauri reads the dev server output; keep its messages visible.
  clearScreen: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
