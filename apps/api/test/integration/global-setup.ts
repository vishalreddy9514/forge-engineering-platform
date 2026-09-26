import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Same image as docker-compose.yml and (major version) as RDS, so tests see real behaviour.
const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg16';
const REDIS_IMAGE = 'redis:7.4-alpine';

declare global {
  var __POSTGRES_CONTAINER__: StartedPostgreSqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedRedisContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;

  const [postgres, redis] = await Promise.all([
    url
      ? undefined
      : new PostgreSqlContainer(POSTGRES_IMAGE)
          .withDatabase('forge_test')
          .withUsername('forge')
          .withPassword('forge_test_password')
          .start(),
    redisUrl ? undefined : new RedisContainer(REDIS_IMAGE).start(),
  ]);
  if (postgres) {
    globalThis.__POSTGRES_CONTAINER__ = postgres;
    url = postgres.getConnectionUri();
  }
  if (redis) {
    globalThis.__REDIS_CONTAINER__ = redis;
    redisUrl = redis.getConnectionUrl();
  }
  if (!url || !redisUrl) throw new Error('Test infrastructure did not start');

  // Apply the real migrations exactly as a deployment would.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  // Jest starts test workers after global setup, so they inherit this variable.
  process.env.INTEGRATION_DATABASE_URL = url;
  process.env.INTEGRATION_REDIS_URL = redisUrl;
}
