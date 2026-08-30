import { defineConfig } from '@playwright/test'

/** End-to-end smoke tests: real backend (uvicorn + OpenDSS) + Vite dev server. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'python -m uvicorn opendss_designer.server:app --host 127.0.0.1 --port 8721',
      url: 'http://127.0.0.1:8721/api/health',
      cwd: '..',
      env: { PYTHONPATH: 'src' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
