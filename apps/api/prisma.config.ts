import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env files itself. Load the same files the API does (app-level
// override first, then the monorepo root) without overriding variables already set, so CI and
// deployed environments keep full control.
for (const file of ['.env', '../../.env']) {
  const path = resolve(__dirname, file);
  if (existsSync(path)) process.loadEnvFile(path);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // `prisma generate` does not need a database; migrate/seed commands fail clearly if unset.
  datasource: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : undefined,
});
