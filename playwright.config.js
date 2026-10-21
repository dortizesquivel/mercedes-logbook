import { defineConfig, devices } from '@playwright/test';

// Browser tests run the card in test/demo.html: sample trips and a stand-in for Home Assistant's API.
// Madrid's time zone, like the demo's trips, so "today" and the hour filter mean the same everywhere.
export default defineConfig({
  testDir: 'test/browser',
  timeout: 30_000,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8765',
    timezoneId: 'Europe/Madrid',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve.mjs 8765',
    url: 'http://localhost:8765/test/demo.html',
    reuseExistingServer: !process.env.CI,
  },
});
