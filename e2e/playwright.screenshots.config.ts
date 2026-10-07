import { defineConfig, devices } from '@playwright/test';

/**
 * The README's screenshots, captured from the seeded demo data on a running stack:
 *
 *   pnpm stack:up && pnpm stack:seed
 *   pnpm --filter @forge/e2e screenshots      # writes docs/images/*.png
 *
 * Not part of the test suite: `playwright.config.ts` only runs ./tests.
 */
export default defineConfig({
  testDir: './screenshots',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  },
});
