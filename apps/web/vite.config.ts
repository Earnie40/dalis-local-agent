import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One value drives both dev and preview so /api can never fall through to the
// SPA HTML document when the native RunPod server uses its collision-free port.
const apiTarget = process.env.DACAI_API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
