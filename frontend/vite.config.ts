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
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8721',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
