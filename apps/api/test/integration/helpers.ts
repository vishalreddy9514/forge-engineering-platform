import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'node:crypto';

import { type Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { allocateIssueNumber } from '../../src/issues/issue-number.allocator';

export function databaseUrl(): string {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) throw new Error('INTEGRATION_DATABASE_URL is not set; run via test:integration');
  return url;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl(), max: 20 }) });
}

/** Unique suffix so tests never collide, even when files run in parallel on one database. */
export function uid(): string {
  return randomBytes(4).toString('hex');
}

/** A valid, unique project key such as "T1A2B3C4". */
export function projectKey(): string {
  return `T${uid().toUpperCase()}`.slice(0, 10);
}

export const ROLE = { PROJECT_MANAGER: 1, DEVELOPER: 2, VIEWER: 3 } as const;

/** Postgres error codes we assert on. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  STRING_TOO_LONG: '22001',
} as const;

/**
 * Resolves the Postgres SQLSTATE of a failed database call. Prisma 7 maps driver errors to its
 * own codes (P2002, P2039, …) and keeps the original SQLSTATE on the driver-adapter error, so
 * tests can assert on the database's verdict rather than on message text.
 */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = (
      error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }
    ).meta?.driverAdapterError?.cause;
    return typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
  }
  throw new Error('Expected the database call to fail, but it succeeded');
}

// ───────────── Fixtures ─────────────

export function createUser(prisma: PrismaClient, overrides: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: {
      email: `user-${uid()}@example.test`,
      displayName: 'Test User',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$not-a-real-hash',
      ...overrides,
    },
  });
}

export async function createProject(prisma: PrismaClient, ownerId?: string) {
  const creatorId = ownerId ?? (await createUser(prisma)).id;
  return prisma.project.create({
    data: {
      key: projectKey(),
      name: 'Test project',
      createdById: creatorId,
      members: { create: { userId: creatorId, roleId: ROLE.PROJECT_MANAGER } },
    },
  });
}

/** Creates an issue the way the application will: number allocated in the same transaction. */
export function createIssue(
  prisma: PrismaClient,
  projectId: string,
  reporterId: string,
  data: Partial<Omit<Prisma.IssueUncheckedCreateInput, 'projectId' | 'reporterId' | 'number'>> = {},
) {
  return prisma.$transaction(async (tx) => {
    const number = await allocateIssueNumber(tx, projectId);
    return tx.issue.create({
      data: { projectId, reporterId, number, title: `Issue ${uid()}`, ...data },
    });
  });
}

/** pgvector literal for a vector(1536) that is `value` in dimension `hot` and 0 elsewhere. */
export function oneHotEmbedding(hot: number, value = 1): string {
  const vector = new Array<number>(1536).fill(0);
  vector[hot] = value;
  return `[${vector.join(',')}]`;
}
