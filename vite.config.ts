import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Bun API server (server/index.ts) listens on API_PORT (default 8787).
const apiPort = process.env.API_PORT ?? '8787'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    allowedHosts: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, ws: true },
    },
  },
})
