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
  HIBP_ENABLED: 'false',
  WEB_ORIGIN: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  S3_ENDPOINT: process.env.INTEGRATION_S3_ENDPOINT,
  S3_BUCKET: 'forge-test',
  S3_ACCESS_KEY_ID: 'forge',
  S3_SECRET_ACCESS_KEY: 'forge_dev_storage_secret',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ENSURE_BUCKET: 'true',
});
