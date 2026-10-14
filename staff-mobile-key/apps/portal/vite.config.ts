import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the portal proxies API calls to the backend on :4000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:4000', '/healthz': 'http://localhost:4000' } },
  build: { outDir: 'dist', sourcemap: false },
});
