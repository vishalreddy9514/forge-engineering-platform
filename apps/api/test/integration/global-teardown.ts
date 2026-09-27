import type {} from './global-setup'; // brings the __POSTGRES_CONTAINER__ global into scope

export default async function globalTeardown(): Promise<void> {
  await Promise.all([
    globalThis.__POSTGRES_CONTAINER__?.stop(),
    globalThis.__REDIS_CONTAINER__?.stop(),
    globalThis.__S3_CONTAINER__?.stop(),
  ]);
}
