import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack: the built web app, API and worker, and the Python AI
 * service with its deterministic fake provider, on top of the docker compose infrastructure
 * (migrated and seeded first). Locally `pnpm infra:up && pnpm build`, then `pnpm e2e`.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

// The repository's .env, without overriding anything already set in the environment.
const envFile = `${root}.env`;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? '').replace(/^"(.*)"$/, '$1');
  }
}

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  // Every page load refreshes the session from one address; see RATE_LIMITS_ENABLED.
  RATE_LIMITS_ENABLED: 'false',
  // No outbound calls from tests.
  HIBP_ENABLED: 'false',
  AI_PROVIDER: 'fake',
  LOG_LEVEL: 'warn',
  LOG_PRETTY: 'false',
  AI_LOG_LEVEL: 'WARNING',
  NEXT_TELEMETRY_DISABLED: '1',
};

const BASE_URL = 'http://localhost:3000';
const reuse = !process.env.CI;

export default defineConfig({
  testDir: './tests',
  // Each test creates its own users and project, so tests run in parallel safely.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'ai-service',
      command: 'uv run uvicorn app.main:create_app --factory --port 8000',
      cwd: `${root}apps/ai-service`,
      url: 'http://127.0.0.1:8000/health/live',
      env,
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
    {
      name: 'api',
      command: 'node dist/main.js',
      cwd: `${root}apps/api`,
      url: 'http://127.0.0.1:4000/api/v1/health/ready',
      env,
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
    {
      name: 'worker',
      command: 'node scripts/worker.mjs',
      url: 'http://127.0.0.1:4099',
      env,
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'pnpm exec next start --port 3000',
      cwd: `${root}apps/web`,
      url: `${BASE_URL}/login`,
      env: { ...env, NODE_ENV: 'production' },
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
  ],
});
