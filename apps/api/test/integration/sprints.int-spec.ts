import type { PrismaClient } from '../../src/generated/prisma/client';
import { PG, createIssue, createPrisma, createProject, sqlState, uid } from './helpers';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('sprints', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function createSprint(projectId: string, data: Record<string, unknown> = {}) {
    return prisma.sprint.create({
      data: {
        projectId,
        name: `Sprint ${uid()}`,
        startDate: day('2026-10-01'),
        endDate: day('2026-10-14'),
        ...data,
      },
    });
  }

  const active = () => ({ status: 'ACTIVE' as const, startedAt: new Date() });

  it('allows only one ACTIVE sprint per project', async () => {
    const project = await createProject(prisma);
    await createSprint(project.id, active());

    await expect(sqlState(createSprint(project.id, active()))).resolves.toBe(PG.UNIQUE_VIOLATION);
  });

  it('holds under a race: two concurrent "start sprint" calls, one wins', async () => {
    const project = await createProject(prisma);
    const [a, b] = await Promise.all([createSprint(project.id), createSprint(project.id)]);

    const start = (id: string) =>
      prisma.sprint.update({ where: { id }, data: { status: 'ACTIVE', startedAt: new Date() } });
    const results = await Promise.allSettled([start(a.id), start(b.id)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(
      prisma.sprint.count({ where: { projectId: project.id, status: 'ACTIVE' } }),
    ).resolves.toBe(1);
  });

  it('lets different projects run sprints at the same time, and keeps completed ones', async () => {
    const [p1, p2] = await Promise.all([createProject(prisma), createProject(prisma)]);
    await createSprint(p1.id, active());
    await createSprint(p2.id, active());
    const done = { status: 'COMPLETED' as const, startedAt: new Date(), completedAt: new Date() };
    await createSprint(p1.id, done);
    await createSprint(p1.id, done);

    await expect(prisma.sprint.count({ where: { projectId: p1.id } })).resolves.toBe(3);
  });

  it.each([
    ['end before start', { endDate: day('2026-09-30') }],
    ['ACTIVE without startedAt', { status: 'ACTIVE' }],
    ['PLANNED with startedAt', { startedAt: new Date() }],
    ['COMPLETED without completedAt', { status: 'COMPLETED', startedAt: new Date() }],
  ])('rejects %s', async (_case, data) => {
    const project = await createProject(prisma);
    await expect(sqlState(createSprint(project.id, data))).resolves.toBe(PG.CHECK_VIOLATION);
  });

  describe('membership', () => {
    it('keeps an issue in one sprint at a time while preserving history', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById);
      const [s1, s2] = await Promise.all([createSprint(project.id), createSprint(project.id)]);
      const base = { issueId: issue.id, projectId: project.id };

      await prisma.sprintIssue.create({ data: { ...base, sprintId: s1.id } });
      await expect(
        sqlState(prisma.sprintIssue.create({ data: { ...base, sprintId: s2.id } })),
      ).resolves.toBe(PG.UNIQUE_VIOLATION);

      // Carry over: close the old membership, then join the next sprint.
      await prisma.$transaction([
        prisma.sprintIssue.updateMany({
          where: { issueId: issue.id, removedAt: null },
          data: { removedAt: new Date(), outcome: 'CARRIED_OVER' },
        }),
        prisma.sprintIssue.create({ data: { ...base, sprintId: s2.id } }),
      ]);

      const history = await prisma.sprintIssue.findMany({
        where: { issueId: issue.id },
        orderBy: { id: 'asc' },
        select: { sprintId: true, outcome: true },
      });
      expect(history).toEqual([
        { sprintId: s1.id, outcome: 'CARRIED_OVER' },
        { sprintId: s2.id, outcome: null },
      ]);
    });

    it('requires an outcome exactly when the issue leaves the sprint', async () => {
      const project = await createProject(prisma);
      const issue = await createIssue(prisma, project.id, project.createdById);
      const sprint = await createSprint(project.id);
      await expect(
        sqlState(
          prisma.sprintIssue.create({
            data: {
              sprintId: sprint.id,
              issueId: issue.id,
              projectId: project.id,
              removedAt: new Date(),
            },
          }),
        ),
      ).resolves.toBe(PG.CHECK_VIOLATION);
    });

    it("refuses to put an issue into another project's sprint", async () => {
      const [mine, other] = await Promise.all([createProject(prisma), createProject(prisma)]);
      const issue = await createIssue(prisma, mine.id, mine.createdById);
      const foreignSprint = await createSprint(other.id);

      for (const projectId of [mine.id, other.id]) {
        await expect(
          sqlState(
            prisma.sprintIssue.create({
              data: { sprintId: foreignSprint.id, issueId: issue.id, projectId },
            }),
          ),
        ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
      }
    });
  });
});
