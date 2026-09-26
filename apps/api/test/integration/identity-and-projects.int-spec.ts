import type { PrismaClient } from '../../src/generated/prisma/client';
import {
  PG,
  ROLE,
  createIssue,
  createPrisma,
  createProject,
  createUser,
  sqlState,
  uid,
} from './helpers';

describe('users and projects', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('treats emails case-insensitively (citext unique)', async () => {
    const local = `alice-${uid()}`;
    await createUser(prisma, { email: `${local}@example.test` });

    await expect(
      sqlState(createUser(prisma, { email: `${local.toUpperCase()}@EXAMPLE.TEST` })),
    ).resolves.toBe(PG.UNIQUE_VIOLATION);
    await expect(
      prisma.user.findUnique({ where: { email: `${local.toUpperCase()}@Example.Test` } }),
    ).resolves.not.toBeNull();
  });

  it.each(['pay', 'P', '1PAY', 'PAY-1'])('rejects project key %j', async (key) => {
    const user = await createUser(prisma);
    await expect(
      sqlState(prisma.project.create({ data: { key, name: 'Bad key', createdById: user.id } })),
    ).resolves.toBe(PG.CHECK_VIOLATION);
  });

  it('rejects project keys longer than 10 characters', async () => {
    const user = await createUser(prisma);
    await expect(
      sqlState(
        prisma.project.create({ data: { key: 'ABCDEFGHIJK', name: 'Long', createdById: user.id } }),
      ),
    ).resolves.toBe(PG.STRING_TOO_LONG);
  });

  it('requires project keys to be unique', async () => {
    const project = await createProject(prisma);
    await expect(
      sqlState(
        prisma.project.create({
          data: { key: project.key, name: 'Duplicate', createdById: project.createdById },
        }),
      ),
    ).resolves.toBe(PG.UNIQUE_VIOLATION);
  });

  it('allows one membership per user and project', async () => {
    const project = await createProject(prisma);
    await expect(
      sqlState(
        prisma.projectMember.create({
          data: { projectId: project.id, userId: project.createdById, roleId: ROLE.VIEWER },
        }),
      ),
    ).resolves.toBe(PG.UNIQUE_VIOLATION);
  });

  it('removes project-owned data when a project is deleted (admin hard delete)', async () => {
    const project = await createProject(prisma);
    const issue = await createIssue(prisma, project.id, project.createdById);
    await prisma.issueComment.create({
      data: { issueId: issue.id, authorId: project.createdById, body: 'hello' },
    });
    await prisma.label.create({ data: { projectId: project.id, name: 'bug', color: '#d73a4a' } });

    await prisma.project.delete({ where: { id: project.id } });

    await expect(prisma.issue.count({ where: { projectId: project.id } })).resolves.toBe(0);
    await expect(prisma.issueComment.count({ where: { issueId: issue.id } })).resolves.toBe(0);
    await expect(prisma.label.count({ where: { projectId: project.id } })).resolves.toBe(0);
    await expect(prisma.projectMember.count({ where: { projectId: project.id } })).resolves.toBe(0);
    // The user survives: people outlive projects.
    await expect(prisma.user.count({ where: { id: project.createdById } })).resolves.toBe(1);
  });

  it('prevents deleting a user who reported issues (history must stay attributable)', async () => {
    const project = await createProject(prisma);
    await createIssue(prisma, project.id, project.createdById);
    await expect(
      sqlState(prisma.user.delete({ where: { id: project.createdById } })),
    ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  it('rejects malformed refresh-token hashes', async () => {
    const user = await createUser(prisma);
    await expect(
      sqlState(
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash: 'not-a-sha256-hex-digest'.padEnd(64, 'x'),
            familyId: '0192f3a0-0000-7000-8000-000000000000',
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).resolves.toBe(PG.CHECK_VIOLATION);
  });
});
