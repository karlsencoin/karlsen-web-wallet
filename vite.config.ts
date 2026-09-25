import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The WASM SDK lives in public/karlsen-wasm and is loaded at runtime with a
// dynamic import, so Vite never bundles or transforms it.
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  server: { port: 5173 },
});
