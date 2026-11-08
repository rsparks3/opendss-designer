import { defineConfig } from '@playwright/test'

/** End-to-end smoke tests: real backend (uvicorn + OpenDSS) + Vite dev server.
 *  OPENDSS_API_PORT and VITE_PORT move the two servers (default 8721/5173),
 *  so a run can start fresh servers beside a dev session that holds the
 *  usual ports -- `reuseExistingServer` would otherwise test against it. */
const API_PORT = process.env.OPENDSS_API_PORT ?? '8721'
const WEB_PORT = process.env.VITE_PORT ?? '5173'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `python -m uvicorn opendss_designer.server:app --host 127.0.0.1 --port ${API_PORT}`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      cwd: '..',
      env: { PYTHONPATH: 'src' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
