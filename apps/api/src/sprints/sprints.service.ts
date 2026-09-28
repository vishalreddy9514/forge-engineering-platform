import type {
  Burndown,
  CompleteSprintRequest,
  CreateSprintRequest,
  Sprint,
  UpdateSprintRequest,
  Velocity,
} from '@forge/types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { Prisma, type SprintStatus } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { writeOutbox } from '../outbox/outbox.writer';
import { computeBurndown, type FieldChange } from './burndown';

const fieldError = (path: string, message: string, status: 400 | 409 = 400) => {
  const body = { message: 'Validation failed', errors: [{ path, message }] };
  return status === 409 ? new ConflictException(body) : new BadRequestException(body);
};
const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Prisma.TransactionClient;

interface SprintRow {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  startDate: Date;
  endDate: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CompletionSummary {
  sprint: Sprint;
  completed: number;
  movedToBacklog: number;
  movedToSprint: number;
}

/** Sprint planning and the sprint lifecycle (FR-5): PLANNED → ACTIVE → COMPLETED. */
@Injectable()
export class SprintsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active first, then planned by start date, then completed, most recent first. */
  async list(projectId: string): Promise<Sprint[]> {
    const rows = await this.prisma.sprint.findMany({ where: { projectId } });
    const order: Record<SprintStatus, number> = { ACTIVE: 0, PLANNED: 1, COMPLETED: 2 };
    rows.sort((a, b) => {
      if (a.status !== b.status) return order[a.status] - order[b.status];
      if (a.status === 'COMPLETED') {
        return (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0);
      }
      return a.startDate.getTime() - b.startDate.getTime();
    });
    const stats = await this.stats(rows);
    return rows.map((row) => this.toSprint(row, stats.get(row.id)));
  }

  async get(sprintId: string): Promise<Sprint> {
    const row = await this.prisma.sprint.findUniqueOrThrow({ where: { id: sprintId } });
    const stats = await this.stats([row]);
    return this.toSprint(row, stats.get(row.id));
  }

  async create(projectId: string, input: CreateSprintRequest): Promise<Sprint> {
    try {
      const row = await this.prisma.sprint.create({
        data: {
          projectId,
          name: input.name,
          goal: input.goal ?? null,
          startDate: new Date(input.startDate),
          endDate: new Date(input.endDate),
        },
      });
      return this.toSprint(row, undefined);
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicateName(input.name);
      throw error;
    }
  }

  /** Name, goal and dates can change until the sprint is completed; history is then fixed. */
  async update(sprintId: string, input: UpdateSprintRequest): Promise<Sprint> {
    const existing = await this.prisma.sprint.findUniqueOrThrow({ where: { id: sprintId } });
    if (existing.status === 'COMPLETED') {
      throw new ConflictException('A completed sprint can no longer be changed');
    }
    const startDate = input.startDate ?? dateOnly(existing.startDate);
    const endDate = input.endDate ?? dateOnly(existing.endDate);
    if (endDate < startDate) {
      throw fieldError('endDate', 'The end date must be on or after the start');
    }
    try {
      await this.prisma.sprint.update({
        where: { id: sprintId },
        data: {
          name: input.name,
          goal: input.goal,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicateName(input.name);
      throw error;
    }
    return this.get(sprintId);
  }

  /** Only a planned sprint can be deleted; its issues go back to the backlog. */
  async delete(sprintId: string, user: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const sprint = await this.lock(tx, sprintId);
      if (sprint.status !== 'PLANNED') {
        throw new ConflictException(
          'Only planned sprints can be deleted; started sprints keep their history',
        );
      }
      const members = await tx.sprintIssue.findMany({
        where: { sprintId, removedAt: null },
        select: { issueId: true },
      });
      await this.recordMoves(
        tx,
        members.map((m) => m.issueId),
        user,
        sprint,
        null,
      );
      await tx.sprint.delete({ where: { id: sprintId } });
    });
  }

  async start(sprintId: string, user: AuthUser): Promise<Sprint> {
    await this.prisma
      .$transaction(async (tx) => {
        const sprint = await this.lock(tx, sprintId);
        if (sprint.status !== 'PLANNED') {
          throw new ConflictException(
            sprint.status === 'ACTIVE'
              ? 'This sprint has already started'
              : 'A completed sprint cannot be restarted',
          );
        }
        await tx.sprint.update({
          where: { id: sprintId },
          data: { status: 'ACTIVE', startedAt: new Date() },
        });
        await writeOutbox(
          tx,
          'sprint.started',
          { type: 'sprint', id: sprintId },
          {
            sprintId,
            actorId: user.id,
          },
        );
      })
      .catch(async (error: unknown) => {
        // The partial unique index allows one ACTIVE sprint per project, even under a race.
        if (!isUniqueViolation(error)) throw error;
        const active = await this.prisma.sprint.findFirst({
          where: { status: 'ACTIVE', project: { sprints: { some: { id: sprintId } } } },
          select: { name: true },
        });
        throw new ConflictException(
          `${active?.name ?? 'Another sprint'} is already active. Complete it before starting another.`,
        );
      });
    return this.get(sprintId);
  }

  /**
   * Ends the active sprint (FR-5.2). Done issues are recorded as completed, cancelled or
   * deleted ones as removed, and everything else is carried over: to the backlog, or into a
   * planned sprint of the same project.
   */
  async complete(
    sprintId: string,
    input: CompleteSprintRequest,
    user: AuthUser,
  ): Promise<CompletionSummary> {
    const counts = await this.prisma.$transaction(async (tx) => {
      const sprint = await this.lock(tx, sprintId);
      if (sprint.status !== 'ACTIVE') {
        throw new ConflictException('Only the active sprint can be completed');
      }

      let target: SprintRow | null = null;
      if (input.moveOpenIssuesTo !== 'backlog') {
        target = await tx.sprint.findUnique({ where: { id: input.moveOpenIssuesTo } });
        if (!target || target.projectId !== sprint.projectId || target.status !== 'PLANNED') {
          throw fieldError('moveOpenIssuesTo', 'Choose a planned sprint in this project');
        }
      }

      const now = new Date();
      const members = await tx.sprintIssue.findMany({
        where: { sprintId, removedAt: null },
        select: {
          id: true,
          issueId: true,
          issue: { select: { status: true, deletedAt: true, storyPoints: true } },
        },
      });
      const done = members.filter((m) => !m.issue.deletedAt && m.issue.status === 'DONE');
      const dropped = members.filter(
        (m) => m.issue.deletedAt !== null || m.issue.status === 'CANCELLED',
      );
      const open = members.filter((m) => !done.includes(m) && !dropped.includes(m));

      const close = (rows: typeof members, outcome: 'COMPLETED' | 'CARRIED_OVER' | 'REMOVED') =>
        rows.length === 0
          ? Promise.resolve()
          : tx.sprintIssue.updateMany({
              where: { id: { in: rows.map((r) => r.id) } },
              data: { removedAt: now, outcome },
            });
      await close(done, 'COMPLETED');
      await close(dropped, 'REMOVED');
      await close(open, 'CARRIED_OVER');

      if (target && open.length > 0) {
        await tx.sprintIssue.createMany({
          data: open.map((m) => ({
            sprintId: target.id,
            issueId: m.issueId,
            projectId: sprint.projectId,
            storyPointsAtAdd: m.issue.storyPoints,
            addedAt: now,
          })),
        });
      }
      await this.recordMoves(
        tx,
        open.map((m) => m.issueId),
        user,
        sprint,
        target,
        now,
      );

      await tx.sprint.update({
        where: { id: sprintId },
        data: { status: 'COMPLETED', completedAt: now },
      });
      await writeOutbox(
        tx,
        'sprint.completed',
        { type: 'sprint', id: sprintId },
        {
          sprintId,
          actorId: user.id,
        },
      );
      return {
        completed: done.length,
        movedToBacklog: target ? 0 : open.length,
        movedToSprint: target ? open.length : 0,
      };
    });
    return { sprint: await this.get(sprintId), ...counts };
  }

  /**
   * Adds issues to a planned or active sprint (FR-5.3). An issue already in another open
   * sprint moves; the old membership is closed so the history shows the move.
   */
  async addIssues(sprintId: string, issueIds: string[], user: AuthUser): Promise<Sprint> {
    await this.prisma
      .$transaction(async (tx) => {
        const sprint = await this.lock(tx, sprintId);
        if (sprint.status === 'COMPLETED') {
          throw new ConflictException('Issues cannot be added to a completed sprint');
        }
        const issues = await tx.issue.findMany({
          where: { id: { in: issueIds }, projectId: sprint.projectId, deletedAt: null },
          select: {
            id: true,
            storyPoints: true,
            sprintIssues: {
              where: { removedAt: null },
              select: { id: true, sprint: { select: { id: true, name: true, status: true } } },
            },
          },
        });
        if (issues.length !== issueIds.length) {
          throw fieldError('issueIds', 'Some of these issues do not exist in this project');
        }

        const now = new Date();
        const toAdd = issues.filter((i) => i.sprintIssues[0]?.sprint.id !== sprintId);
        for (const issue of toAdd) {
          const current = issue.sprintIssues[0];
          if (current) {
            await tx.sprintIssue.update({
              where: { id: current.id },
              data: { removedAt: now, outcome: 'REMOVED' },
            });
          }
          await tx.sprintIssue.create({
            data: {
              sprintId,
              issueId: issue.id,
              projectId: sprint.projectId,
              storyPointsAtAdd: issue.storyPoints,
              addedAt: now,
            },
          });
          await tx.issueEvent.create({
            data: {
              issueId: issue.id,
              actorId: user.id,
              type: 'SPRINT_CHANGED',
              field: 'sprint',
              oldValue: current
                ? { id: current.sprint.id, name: current.sprint.name }
                : Prisma.JsonNull,
              newValue: { id: sprint.id, name: sprint.name },
              createdAt: now,
            },
          });
          await tx.issue.update({ where: { id: issue.id }, data: { updatedAt: now } });
        }
      })
      .catch((error: unknown) => {
        // Someone added the same issue to a sprint at the same moment.
        if (isUniqueViolation(error)) {
          throw new ConflictException('An issue was moved by someone else. Please try again.');
        }
        throw error;
      });
    return this.get(sprintId);
  }

  /** Takes an issue out of a planned or active sprint; it returns to the backlog. */
  async removeIssue(sprintId: string, issueId: string, user: AuthUser): Promise<void> {
    if (!UUID.test(issueId)) throw new NotFoundException('This issue is not in the sprint');
    await this.prisma.$transaction(async (tx) => {
      const sprint = await this.lock(tx, sprintId);
      if (sprint.status === 'COMPLETED') {
        throw new ConflictException('A completed sprint can no longer be changed');
      }
      const { count } = await tx.sprintIssue.updateMany({
        where: { sprintId, issueId, removedAt: null },
        data: { removedAt: new Date(), outcome: 'REMOVED' },
      });
      if (count === 0) throw new NotFoundException('This issue is not in the sprint');
      await this.recordMoves(tx, [issueId], user, sprint, null);
    });
  }

  async burndown(sprintId: string): Promise<Burndown> {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({
      where: { id: sprintId },
      include: {
        issues: {
          select: {
            issueId: true,
            addedAt: true,
            removedAt: true,
            outcome: true,
            issue: { select: { status: true, storyPoints: true } },
          },
        },
      },
    });
    const issueIds = [...new Set(sprint.issues.map((m) => m.issueId))];
    const events = await this.prisma.issueEvent.findMany({
      where: {
        issueId: { in: issueIds },
        type: 'FIELD_CHANGED',
        field: { in: ['status', 'storyPoints'] },
      },
      select: { issueId: true, field: true, oldValue: true, newValue: true, createdAt: true },
    });
    return computeBurndown({
      sprintId,
      startDate: dateOnly(sprint.startDate),
      endDate: dateOnly(sprint.endDate),
      startedAt: sprint.startedAt,
      completedAt: sprint.completedAt,
      now: new Date(),
      memberships: sprint.issues,
      issues: new Map(sprint.issues.map((m) => [m.issueId, m.issue])),
      changes: events.map((e): FieldChange => ({
        issueId: e.issueId,
        field: e.field as FieldChange['field'],
        oldValue: e.oldValue,
        newValue: e.newValue,
        at: e.createdAt,
      })),
    });
  }

  /**
   * Completed points per sprint over the last completed sprints (FR-5.4). "Committed" is what
   * the sprint held when it started; "completed" is what was done when it ended.
   */
  async velocity(projectId: string, count: number): Promise<Velocity> {
    const sprints = await this.prisma.sprint.findMany({
      where: { projectId, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      take: count,
      include: {
        issues: {
          select: {
            addedAt: true,
            outcome: true,
            storyPointsAtAdd: true,
            issue: { select: { storyPoints: true } },
          },
        },
      },
    });
    const rows = sprints.reverse().map((sprint) => {
      const startedAt = sprint.startedAt ?? sprint.completedAt ?? new Date(0);
      const committed = sprint.issues
        .filter((m) => m.addedAt <= startedAt)
        .reduce((sum, m) => sum + (m.storyPointsAtAdd ?? 0), 0);
      const completed = sprint.issues
        .filter((m) => m.outcome === 'COMPLETED')
        .reduce((sum, m) => sum + (m.issue.storyPoints ?? 0), 0);
      return {
        id: sprint.id,
        name: sprint.name,
        completedAt: (sprint.completedAt ?? new Date(0)).toISOString(),
        committed,
        completed,
      };
    });
    const average =
      rows.length > 0
        ? Math.round((rows.reduce((sum, r) => sum + r.completed, 0) / rows.length) * 10) / 10
        : null;
    return { sprints: rows, average };
  }

  /** Serialises lifecycle changes to one sprint (start, complete, membership). */
  private async lock(tx: Tx, sprintId: string): Promise<SprintRow> {
    const [row] = await tx.$queryRaw<SprintRow[]>`
      SELECT id, project_id AS "projectId", name, goal, status, start_date AS "startDate",
             end_date AS "endDate", started_at AS "startedAt", completed_at AS "completedAt"
      FROM sprints WHERE id = ${sprintId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Sprint not found');
    return row;
  }

  private async recordMoves(
    tx: Tx,
    issueIds: string[],
    user: AuthUser,
    from: { id: string; name: string },
    to: { id: string; name: string } | null,
    at = new Date(),
  ): Promise<void> {
    if (issueIds.length === 0) return;
    await tx.issueEvent.createMany({
      data: issueIds.map((issueId) => ({
        issueId,
        actorId: user.id,
        type: 'SPRINT_CHANGED' as const,
        field: 'sprint',
        oldValue: { id: from.id, name: from.name },
        newValue: to ? { id: to.id, name: to.name } : Prisma.JsonNull,
        createdAt: at,
      })),
    });
    await tx.issue.updateMany({ where: { id: { in: issueIds } }, data: { updatedAt: at } });
  }

  /** Issue counts and points: current members, or for a completed sprint what it ended with. */
  private async stats(rows: SprintRow[]) {
    const result = new Map<string, { count: number; total: number; done: number }>();
    if (rows.length === 0) return result;
    const members = await this.prisma.sprintIssue.findMany({
      where: {
        sprintId: { in: rows.map((r) => r.id) },
        OR: [{ removedAt: null }, { outcome: { in: ['COMPLETED', 'CARRIED_OVER'] } }],
        issue: { deletedAt: null },
      },
      select: {
        sprintId: true,
        removedAt: true,
        outcome: true,
        issue: { select: { status: true, storyPoints: true } },
      },
    });
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    for (const m of members) {
      const completed = statusById.get(m.sprintId) === 'COMPLETED';
      // Open sprints: current members only. Completed: the rows closed at completion.
      if (completed === (m.removedAt === null)) continue;
      const entry = result.get(m.sprintId) ?? { count: 0, total: 0, done: 0 };
      const points = m.issue.storyPoints ?? 0;
      entry.count += 1;
      entry.total += points;
      const isDone = completed ? m.outcome === 'COMPLETED' : m.issue.status === 'DONE';
      if (isDone) entry.done += points;
      result.set(m.sprintId, entry);
    }
    return result;
  }

  private toSprint(
    row: SprintRow,
    stats: { count: number; total: number; done: number } | undefined,
  ): Sprint {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      goal: row.goal,
      status: row.status,
      startDate: dateOnly(row.startDate),
      endDate: dateOnly(row.endDate),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      issueCount: stats?.count ?? 0,
      points: { total: stats?.total ?? 0, done: stats?.done ?? 0 },
    };
  }

  private duplicateName(name: string | undefined) {
    return fieldError('name', `A sprint named "${name ?? ''}" already exists`, 409);
  }
}
