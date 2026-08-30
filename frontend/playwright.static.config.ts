import { defineConfig } from '@playwright/test'

/** Variant config: run the e2e suite against the packaged static build served
 *  by uvicorn on :8721 (no Vite). Start the server yourself first. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8721' },
})
