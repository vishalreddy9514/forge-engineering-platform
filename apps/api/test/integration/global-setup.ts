import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Same image as docker-compose.yml and (major version) as RDS, so tests see real behaviour.
const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg16';

declare global {
  var __POSTGRES_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;

  if (!url) {
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('forge_test')
      .withUsername('forge')
      .withPassword('forge_test_password')
      .start();
    globalThis.__POSTGRES_CONTAINER__ = container;
    url = container.getConnectionUri();
  }

  // Apply the real migrations exactly as a deployment would.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  // Jest starts test workers after global setup, so they inherit this variable.
  process.env.INTEGRATION_DATABASE_URL = url;
}
