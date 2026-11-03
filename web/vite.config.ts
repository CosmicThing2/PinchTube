/*
 * vite.config.ts — build settings for the web app.
 *
 * Vite bundles web/src into static files in web/dist, which the Docker image
 * copies to where the server serves them (server/src/index.ts). For
 * development, `npm run dev` serves the app on port 5173 and passes /api
 * requests on to a running PinchTube server (VITE_API_TARGET, default
 * localhost:8080).
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
