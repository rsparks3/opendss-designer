/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'node_modules/**'],
  },
  server: {
    // Bind explicitly to IPv4 — on Windows, plain `localhost` can resolve to
    // ::1 only, which breaks the Playwright webServer health check.
    host: '127.0.0.1',
    // Both ports can be moved for a second checkout or a parallel e2e run:
    // VITE_PORT for this server, OPENDSS_API_PORT for the backend it proxies.
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.OPENDSS_API_PORT ?? 8721}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
