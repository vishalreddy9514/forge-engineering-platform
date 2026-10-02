import { randomInt } from 'node:crypto';

import { ProjectDashboard } from '@forge/types';

import { weekStart } from '../../src/dashboard/weeks';
import { createIssue, uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

describe('project dashboard (HTTP, real Postgres + Redis)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.redis.flushdb();
  });

  /** Monday 00:00 UTC of the current week, shifted by whole weeks, plus some hours. */
  const week = (offset: number, hours = 1) =>
    new Date(Date.parse(`${weekStart(new Date())}T00:00:00Z`) + offset * WEEK + hours * HOUR);
  const mondays = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      week(i - count + 1, 0)
        .toISOString()
        .slice(0, 10),
    );

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
    outsider: SignedInUser;
  }

  async function project(owner: SignedInUser, name = 'Dashboard') {
    const key = `D${uid().toUpperCase()}`.slice(0, 8);
    return (await t.http.post('/api/v1/projects').set(owner.auth).send({ key, name }).expect(201))
      .body as { id: string; key: string };
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat' }),
      signIn(t, { displayName: 'Dev' }),
      signIn(t, { displayName: 'Vic' }),
      signIn(t, { displayName: 'Out' }),
    ]);
    const p = await project(pm);
    for (const [user, role] of [
      [dev, 'DEVELOPER'],
      [viewer, 'VIEWER'],
    ] as const) {
      await t.http
        .post(`/api/v1/projects/${p.id}/members`)
        .set(pm.auth)
        .send({ email: user.email, role })
        .expect(201);
    }
    return { project: p, pm, dev, viewer, outsider };
  }

  const get = (w: World, user: SignedInUser, query = '') =>
    t.http.get(`/api/v1/projects/${w.project.id}/dashboard${query}`).set(user.auth);

  async function repository(linkedTo?: string) {
    const installation = await t.prisma.githubInstallation.create({
      data: {
        installationId: randomInt(1, 2 ** 31),
        accountLogin: 'acme',
        accountType: 'ORGANIZATION',
      },
    });
    const repo = await t.prisma.githubRepository.create({
      data: {
        installationId: installation.id,
        githubId: randomInt(1, 2 ** 31),
        fullName: `acme/${uid()}`,
        defaultBranch: 'main',
        isPrivate: true,
        htmlUrl: 'https://github.com/acme/x',
      },
    });
    if (linkedTo) {
      await t.prisma.projectRepository.create({
        data: { projectId: linkedTo, repositoryId: repo.id },
      });
    }
    return repo;
  }

  async function pullRequest(repositoryId: string, openedAt: Date, mergedAt: Date | null = null) {
    const number = randomInt(1, 100_000);
    await t.prisma.githubPullRequest.create({
      data: {
        repositoryId,
        githubId: randomInt(1, 2 ** 31),
        number,
        title: `PR ${String(number)}`,
        state: mergedAt ? 'MERGED' : 'OPEN',
        headRef: 'feature',
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        htmlUrl: `https://github.com/acme/x/pull/${String(number)}`,
        openedAt,
        mergedAt,
        closedAt: mergedAt,
        githubUpdatedAt: mergedAt ?? openedAt,
      },
    });
  }

  it('aggregates a known dataset exactly, and nothing from other projects', async () => {
    const w = await world();
    const other = await project(w.pm, 'Elsewhere');
    const issue = (data: Parameters<typeof createIssue>[3]) =>
      createIssue(t.prisma, w.project.id, w.pm.id, data);

    // Open work: Dev has 8 points over two issues, Pat 8 over one, 20 unassigned over two.
    const a = await issue({
      assigneeId: w.dev.id,
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      storyPoints: 5,
    });
    const b = await issue({
      assigneeId: w.dev.id,
      priority: 'CRITICAL',
      status: 'TODO',
      storyPoints: 3,
    });
    await issue({ assigneeId: w.pm.id, priority: 'MEDIUM', status: 'IN_REVIEW', storyPoints: 8 });
    await issue({ priority: 'LOW', status: 'BACKLOG', storyPoints: 20 });
    await issue({ priority: 'HIGH', status: 'TODO' });
    // Done last week after 10, 20, 30 and 100 hours: median 25, p90 79 (linear interpolation).
    const done = [];
    for (const hours of [10, 20, 30, 100]) {
      done.push(
        await issue({
          status: 'DONE',
          storyPoints: 3,
          createdAt: week(-1),
          resolvedAt: new Date(week(-1).getTime() + hours * HOUR),
        }),
      );
    }
    // Outside the resolution figures: done before the period, cancelled, or deleted.
    await issue({ status: 'DONE', createdAt: week(-10), resolvedAt: week(-10, 2) });
    await issue({ status: 'CANCELLED', createdAt: week(-1), resolvedAt: week(-1, 2) });
    await issue({ assigneeId: w.dev.id, status: 'TODO', storyPoints: 13, deletedAt: new Date() });
    await createIssue(t.prisma, other.id, w.pm.id, { assigneeId: w.dev.id, storyPoints: 21 });

    const [firstDone] = done;
    if (!firstDone) throw new Error('no done issue');
    // Active sprint: A (5, in progress) and a done issue (3); B was removed from it.
    const today = new Date();
    const sprint = await t.prisma.sprint.create({
      data: {
        projectId: w.project.id,
        name: 'Sprint 1',
        goal: 'Ship it',
        status: 'ACTIVE',
        startDate: new Date(today.getTime() - 2 * 24 * HOUR),
        endDate: new Date(today.getTime() + 11 * 24 * HOUR),
        startedAt: new Date(today.getTime() - 2 * 24 * HOUR),
      },
    });
    await t.prisma.sprintIssue.createMany({
      data: [
        { sprintId: sprint.id, projectId: w.project.id, issueId: a.id, storyPointsAtAdd: 5 },
        {
          sprintId: sprint.id,
          projectId: w.project.id,
          issueId: firstDone.id,
          storyPointsAtAdd: 3,
        },
        {
          sprintId: sprint.id,
          projectId: w.project.id,
          issueId: b.id,
          storyPointsAtAdd: 3,
          removedAt: new Date(),
          outcome: 'REMOVED',
        },
      ],
    });

    // Pull requests on the linked repository, and noise on an unlinked one.
    const linked = await repository(w.project.id);
    await pullRequest(linked.id, week(-1), week(0)); // opened last week, merged this week
    await pullRequest(linked.id, week(-1, 30)); // opened last week, still open
    await pullRequest(linked.id, week(0), week(0, 5)); // opened and merged this week
    await pullRequest(linked.id, week(-6), week(-1, 2)); // opened before the period, merged in it
    await pullRequest((await repository()).id, week(0), week(0, 1));
    await pullRequest((await repository(other.id)).id, week(0));

    // AI usage for this project in the period, and noise.
    const usage = (data: {
      projectId: string;
      feature: 'CHAT' | 'PR_REVIEW';
      tokens: [number, number];
      cost: string;
      at: Date;
    }) =>
      t.prisma.aiUsage.create({
        data: {
          userId: w.dev.id,
          projectId: data.projectId,
          feature: data.feature,
          model: 'fake',
          inputTokens: data.tokens[0],
          outputTokens: data.tokens[1],
          latencyMs: 100,
          costUsd: data.cost,
          success: true,
          createdAt: data.at,
        },
      });
    await usage({
      projectId: w.project.id,
      feature: 'CHAT',
      tokens: [80, 20],
      cost: '0.001',
      at: week(0),
    });
    await usage({
      projectId: w.project.id,
      feature: 'CHAT',
      tokens: [40, 10],
      cost: '0.0015',
      at: week(0, 2),
    });
    await usage({
      projectId: w.project.id,
      feature: 'PR_REVIEW',
      tokens: [900, 100],
      cost: '0.01',
      at: week(-1),
    });
    await usage({
      projectId: w.project.id,
      feature: 'CHAT',
      tokens: [1, 1],
      cost: '1',
      at: week(-9),
    });
    await usage({ projectId: other.id, feature: 'CHAT', tokens: [1, 1], cost: '1', at: week(0) });

    const res = await get(w, w.viewer, '?weeks=4').expect(200);
    const body = ProjectDashboard.parse(res.body);
    const [w3, w2, w1, w0] = mondays(4);

    expect(body.since).toBe(w3);
    expect(body.issues).toEqual({
      open: 5,
      byStatus: { BACKLOG: 1, TODO: 2, IN_PROGRESS: 1, IN_REVIEW: 1, DONE: 5, CANCELLED: 1 },
      byPriority: { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 1 },
    });
    expect(
      body.workload.map((r) => [r.assignee?.displayName ?? null, r.openIssues, r.openPoints]),
    ).toEqual([
      ['Dev', 2, 8], // ties with Pat on points; more issues first
      ['Pat', 1, 8],
      [null, 2, 20], // the most points, but the unassigned pile is a queue: listed last
    ]);
    expect(body.activeSprint).toMatchObject({
      id: sprint.id,
      name: 'Sprint 1',
      goal: 'Ship it',
      totalPoints: 8,
      donePoints: 3,
      totalIssues: 2,
      doneIssues: 1,
      burndown: { sprintId: sprint.id },
    });
    expect(body.pullRequests).toEqual({
      repositories: 1,
      weeks: [
        { weekStart: w3, opened: 0, merged: 0 },
        { weekStart: w2, opened: 0, merged: 0 },
        { weekStart: w1, opened: 2, merged: 1 },
        { weekStart: w0, opened: 1, merged: 2 },
      ],
    });
    expect(body.resolution).toEqual({ resolved: 4, medianHours: 25, p90Hours: 79 });
    expect(body.aiUsage).toEqual({
      weeks: [
        { weekStart: w1, feature: 'PR_REVIEW', requests: 1, tokens: 1000, costUsd: 0.01 },
        { weekStart: w0, feature: 'CHAT', requests: 2, tokens: 150, costUsd: 0.0025 },
      ],
      totals: { requests: 3, tokens: 1150, costUsd: 0.0125 },
    });
  });

  it('shows an empty project as zeros, with every week listed', async () => {
    const w = await world();
    const body = ProjectDashboard.parse((await get(w, w.pm).expect(200)).body);
    expect(body.issues.open).toBe(0);
    expect(Object.values(body.issues.byStatus).every((n) => n === 0)).toBe(true);
    expect(body.activeSprint).toBeNull();
    expect(body.workload).toEqual([]);
    expect(body.pullRequests).toEqual({
      repositories: 0,
      weeks: mondays(8).map((weekStart) => ({ weekStart, opened: 0, merged: 0 })),
    });
    expect(body.resolution).toEqual({ resolved: 0, medianHours: null, p90Hours: null });
    expect(body.aiUsage).toEqual({ weeks: [], totals: { requests: 0, tokens: 0, costUsd: 0 } });
  });

  it('is readable by every member, hidden from outsiders, and validates the window', async () => {
    const w = await world();
    await get(w, w.dev).expect(200);
    await get(w, w.viewer).expect(200);
    await get(w, w.outsider).expect(404);
    await t.http.get(`/api/v1/projects/${w.project.id}/dashboard`).expect(401);
    await get(w, w.pm, '?weeks=27').expect(400);
    await get(w, w.pm, '?weeks=0').expect(400);
  });
});
