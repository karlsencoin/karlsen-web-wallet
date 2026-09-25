import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The WASM SDK lives in public/karlsen-wasm and is loaded at runtime with a
// dynamic import, so Vite never bundles or transforms it.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Optional same-origin proxy to a bridge daemon that only listens on
  // localhost (dev / preview on Mine1). Production uses VITE_BRIDGE_API_URL.
  const target = env.BRIDGE_PROXY_TARGET;
  const proxy = target ? { '/bridge-api': { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/bridge-api/, '') } } : undefined;
  return {
    plugins: [react()],
    build: { target: 'es2022', sourcemap: false },
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
