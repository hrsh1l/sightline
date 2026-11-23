import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite dev server runs in middleware mode inside the Node backend (src/server/index.ts),
// so browser UI, /api and /ws share one origin and port. No proxy is needed.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
  // Only VITE_-prefixed env vars could ever reach the client. We define none; secrets have no VITE_ prefix.
  envPrefix: 'VITE_PUBLIC_',
});
