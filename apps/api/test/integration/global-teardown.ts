import type {} from './global-setup'; // brings the __POSTGRES_CONTAINER__ global into scope

export default async function globalTeardown(): Promise<void> {
  await globalThis.__POSTGRES_CONTAINER__?.stop();
}
