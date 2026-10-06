import { generateKeyPairSync } from 'node:crypto';

// Runs in each Jest worker before any test file is loaded, so AppModule's env validation sees
// the Testcontainers endpoints.
const workerId = Number(process.env.JEST_WORKER_ID ?? '1');
const redisUrl = new URL(process.env.INTEGRATION_REDIS_URL ?? 'redis://localhost:6379');
// One Redis logical database per worker: rate-limit counters and caches from test files running
// in parallel can never interfere (all requests come from the same loopback IP).
redisUrl.pathname = `/${workerId % 16}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.INTEGRATION_DATABASE_URL,
  REDIS_URL: redisUrl.toString(),
  LOG_LEVEL: 'fatal',
  METRICS_PORT: '0',
  HIBP_ENABLED: 'false',
  WEB_ORIGIN: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  S3_ENDPOINT: process.env.INTEGRATION_S3_ENDPOINT,
  S3_BUCKET: 'forge-test',
  S3_ACCESS_KEY_ID: 'forge',
  S3_SECRET_ACCESS_KEY: 'forge_dev_storage_secret',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ENSURE_BUCKET: 'true',
  ...githubApp(),
  // A fake AI service (ai/fake-ai-service.ts) on a per-worker port, replaying the contract
  // files the real service's tests produce.
  AI_SERVICE_URL: `http://127.0.0.1:${String(48_000 + workerId)}`,
  AI_SERVICE_TOKEN: 'integration-ai-service-token-0123456789',
  AI_DAILY_TOKEN_BUDGET: '5000',
});

/**
 * A GitHub App identity for this worker. The API talks to a fake GitHub (github/fake-github.ts)
 * on a per-worker port, which verifies the App JWT with the public half of this key.
 */
function githubApp(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    GITHUB_APP_ID: '4242',
    GITHUB_APP_SLUG: 'forge-test',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: 'integration-webhook-secret-0123456789',
    GITHUB_API_URL: `http://127.0.0.1:${String(47_000 + workerId)}`,
    GITHUB_RATE_LIMIT_RESERVE: '10',
    GITHUB_SYNC_MAX_PAGES: '5',
    INTEGRATION_GITHUB_PUBLIC_KEY: publicKey,
  };
}
