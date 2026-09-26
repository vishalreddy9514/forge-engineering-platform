import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import type { PrismaClient } from '../../src/generated/prisma/client';
import { createPrisma, databaseUrl } from './helpers';

describe('migrations', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('leave the database exactly matching schema.prisma (no drift)', () => {
    // --exit-code: 0 = no difference, 2 = difference. A non-zero exit throws here, and the
    // generated SQL in the error output shows what drifted.
    const output = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        encoding: 'utf8',
      },
    );
    expect(output).toContain('No difference detected');
  });

  it('install the required extensions', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm', 'vector')
      ORDER BY extname`;
    expect(rows.map((row) => row.extname)).toEqual(['citext', 'pg_trgm', 'vector']);
  });

  it('seed the three project roles as reference data', async () => {
    const roles = await prisma.role.findMany({ orderBy: { id: 'asc' }, select: { key: true } });
    expect(roles.map((role) => role.key)).toEqual(['PROJECT_MANAGER', 'DEVELOPER', 'VIEWER']);
  });
});
