import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GD_PORT and GD_CLIENT_PORT (see scripts/dev.mjs) let a second checkout run beside the first.
const api = `localhost:${process.env.GD_PORT ?? 3000}`;
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.GD_CLIENT_PORT ?? 5173),
    proxy: {
      '/api': `http://${api}`,
      '/ws': { target: `ws://${api}`, ws: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
