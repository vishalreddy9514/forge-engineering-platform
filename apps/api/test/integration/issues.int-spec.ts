import type { PrismaClient } from '../../src/generated/prisma/client';
import { allocateIssueNumber } from '../../src/issues/issue-number.allocator';
import { PG, createIssue, createPrisma, createProject, sqlState } from './helpers';

describe('issues', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('per-project numbering', () => {
    it('hands out unique, gap-free numbers under concurrent creates', async () => {
      const project = await createProject(prisma);
      const creates = 25;

      const issues = await Promise.all(
        Array.from({ length: creates }, () => createIssue(prisma, project.id, project.createdById)),
      );

      const numbers = issues.map((issue) => issue.number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: creates }, (_, i) => i + 1));
      await expect(
        prisma.project.findUniqueOrThrow({ where: { id: project.id } }),
      ).resolves.toMatchObject({ issueSeq: creates });
    });

    it('does not burn a number when the creating transaction rolls back', async () => {
      const project = await createProject(prisma);
      await createIssue(prisma, project.id, project.createdById); // PAY-1

      await expect(
        prisma.$transaction(async (tx) => {
          await allocateIssueNumber(tx, project.id); // would be 2
          throw new Error('validation failed after allocation');
        }),
      ).rejects.toThrow('validation failed');

      const next = await createIssue(prisma, project.id, project.createdById);
      expect(next.number).toBe(2);
    });

    it('numbers each project independently', async () => {
      const [a, b] = await Promise.all([createProject(prisma), createProject(prisma)]);
      const [issueA, issueB] = await Promise.all([
        createIssue(prisma, a.id, a.createdById),
        createIssue(prisma, b.id, b.createdById),
      ]);
      expect([issueA.number, issueB.number]).toEqual([1, 1]);
    });
  });

  describe('integrity rules', () => {
    it.each([
      ['a terminal status without resolvedAt', { status: 'DONE' as const }],
      ['resolvedAt on an open issue', { status: 'TODO' as const, resolvedAt: new Date() }],
      ['story points above 100', { storyPoints: 101 }],
      ['negative story points', { storyPoints: -1 }],
      ['a blank title', { title: '   ' }],
    ])('rejects %s', async (_case, data) => {
      const project = await createProject(prisma);
      await expect(
        sqlState(createIssue(prisma, project.id, project.createdById, data)),
      ).resolves.toBe(PG.CHECK_VIOLATION);
    });

    it('accepts a resolved issue with resolvedAt set', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById, {
        status: 'DONE',
        resolvedAt: new Date(),
      });
      expect(issue.status).toBe('DONE');
    });

    it('refuses a label from another project, even with valid IDs (composite FK)', async () => {
      const [mine, other] = await Promise.all([createProject(prisma), createProject(prisma)]);
      const issue = await createIssue(prisma, mine.id, mine.createdById);
      const foreignLabel = await prisma.label.create({
        data: { projectId: other.id, name: 'bug', color: '#d73a4a' },
      });

      await expect(
        sqlState(
          prisma.issueLabel.create({
            data: { issueId: issue.id, labelId: foreignLabel.id, projectId: mine.id },
          }),
        ),
      ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
      await expect(
        sqlState(
          prisma.issueLabel.create({
            data: { issueId: issue.id, labelId: foreignLabel.id, projectId: other.id },
          }),
        ),
      ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
    });

    it('rejects label colours that are not #rrggbb', async () => {
      const project = await createProject(prisma);
      await expect(
        sqlState(prisma.label.create({ data: { projectId: project.id, name: 'x', color: 'red' } })),
      ).resolves.toBe(PG.CHECK_VIOLATION);
    });

    it('enforces the 10 MiB attachment limit', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById);
      await expect(
        sqlState(
          prisma.attachment.create({
            data: {
              issueId: issue.id,
              uploadedById: project.createdById,
              fileName: 'huge.zip',
              contentType: 'application/zip',
              sizeBytes: 10 * 1024 * 1024 + 1,
              storageKey: `attachments/${issue.id}/huge.zip`,
            },
          }),
        ),
      ).resolves.toBe(PG.CHECK_VIOLATION);
    });

    it('allows exactly one target per issue link', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById);
      await expect(
        sqlState(prisma.issueLink.create({ data: { issueId: issue.id, linkType: 'COMMIT' } })),
      ).resolves.toBe(PG.CHECK_VIOLATION);
    });
  });

  describe('full-text search column', () => {
    it('is generated from title and description, with stemming and title weighted higher', async () => {
      const project = await createProject(prisma);
      const reporter = project.createdById;
      const inTitle = await createIssue(prisma, project.id, reporter, {
        title: 'Users cannot reset their password',
        description: 'The email never arrives.',
      });
      const inBody = await createIssue(prisma, project.id, reporter, {
        title: 'Login page styling',
        description: 'After a password reset the button is misaligned.',
      });
      await createIssue(prisma, project.id, reporter, { title: 'Unrelated payments bug' });

      // "resetting passwords" matches "reset … password" through English stemming.
      const rows = await prisma.$queryRaw<{ id: string; rank: number }[]>`
        SELECT id, ts_rank(search_vector, query) AS rank
        FROM issues, websearch_to_tsquery('english', 'resetting passwords') AS query
        WHERE project_id = ${project.id}::uuid AND search_vector @@ query
        ORDER BY rank DESC`;

      expect(rows.map((row) => row.id)).toEqual([inTitle.id, inBody.id]);
    });

    it('updates when the title changes', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById, {
        title: 'Original wording',
      });
      await prisma.issue.update({ where: { id: issue.id }, data: { title: 'Kafka consumer lag' } });

      const [row] = await prisma.$queryRaw<{ matches: boolean }[]>`
        SELECT search_vector @@ to_tsquery('english', 'kafka') AS matches
        FROM issues WHERE id = ${issue.id}::uuid`;
      expect(row?.matches).toBe(true);
    });
  });
});
