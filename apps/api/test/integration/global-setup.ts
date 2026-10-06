import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Same image as docker-compose.yml and (major version) as RDS, so tests see real behaviour.
const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg16';
const REDIS_IMAGE = 'redis:7.4-alpine';
// Same S3-compatible store and credentials file as docker-compose.yml.
const S3_IMAGE = 'chrislusf/seaweedfs:3.97';
const S3_CONFIG = resolve(__dirname, '../../../../infrastructure/docker/seaweedfs/s3.json');

declare global {
  var __POSTGRES_CONTAINER__: StartedPostgreSqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedRedisContainer | undefined;
  var __S3_CONTAINER__: StartedTestContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;
  let s3Endpoint = process.env.TEST_S3_ENDPOINT;

  const [postgres, redis, s3] = await Promise.all([
    url
      ? undefined
      : new PostgreSqlContainer(POSTGRES_IMAGE)
          .withDatabase('forge_test')
          .withUsername('forge')
          .withPassword('forge_test_password')
          .start(),
    redisUrl ? undefined : new RedisContainer(REDIS_IMAGE).start(),
    s3Endpoint
      ? undefined
      : new GenericContainer(S3_IMAGE)
          .withCommand([
            'server',
            '-dir=/data',
            '-volume.max=5',
            // As in docker-compose.yml: the defaults preallocate 1 GB per volume file, seven at
            // a time, which fails uploads with InternalError when the disk is short of space.
            '-master.volumeSizeLimitMB=64',
            '-master.volumePreallocate=false',
            '-s3',
            '-s3.port=8333',
            '-s3.config=/etc/seaweedfs/s3.json',
          ])
          .withCopyFilesToContainer([{ source: S3_CONFIG, target: '/etc/seaweedfs/s3.json' }])
          .withExposedPorts(8333)
          .withWaitStrategy(Wait.forHttp('/status', 8333).forStatusCode(200))
          .withStartupTimeout(120_000)
          .start(),
  ]);
  if (postgres) {
    globalThis.__POSTGRES_CONTAINER__ = postgres;
    url = postgres.getConnectionUri();
  }
  if (redis) {
    globalThis.__REDIS_CONTAINER__ = redis;
    redisUrl = redis.getConnectionUrl();
  }
  if (s3) {
    globalThis.__S3_CONTAINER__ = s3;
    s3Endpoint = `http://${s3.getHost()}:${String(s3.getMappedPort(8333))}`;
    await untilWritable(s3Endpoint);
  }
  if (!url || !redisUrl || !s3Endpoint) throw new Error('Test infrastructure did not start');

  // Apply the real migrations exactly as a deployment would.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  // Jest starts test workers after global setup, so they inherit this variable.
  process.env.INTEGRATION_DATABASE_URL = url;
  process.env.INTEGRATION_REDIS_URL = redisUrl;
  process.env.INTEGRATION_S3_ENDPOINT = s3Endpoint;
}

/**
 * SeaweedFS answers /status before its volume server has registered with the master; until
 * then every upload fails with InternalError. On a loaded machine that takes long enough for the
 * first tests to hit it, so wait for a real write to succeed.
 */
async function untilWritable(endpoint: string, timeoutMs = 60_000): Promise<void> {
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'forge', secretAccessKey: 'forge_dev_storage_secret' },
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: 'forge-test' })).catch((error: unknown) => {
          if (!(error instanceof S3ServiceException && /BucketAlready/.test(error.name)))
            throw error;
        });
        await s3.send(new PutObjectCommand({ Bucket: 'forge-test', Key: 'probe', Body: 'ok' }));
        await s3.send(new DeleteObjectCommand({ Bucket: 'forge-test', Key: 'probe' }));
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 500));
      }
    }
  } finally {
    s3.destroy();
  }
}
