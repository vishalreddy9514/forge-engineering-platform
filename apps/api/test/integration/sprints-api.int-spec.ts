import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

interface SprintBody {
  id: string;
  status: string;
  issueCount: number;
  points: { total: number; done: number };
}

describe('sprints (HTTP, real Postgres + Redis)', () => {
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

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
    outsider: SignedInUser;
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat' }),
      signIn(t, { displayName: 'Dev' }),
      signIn(t, { displayName: 'Vic' }),
      signIn(t, { displayName: 'Out' }),
    ]);
    const key = `S${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http.post('/api/v1/projects').set(pm.auth).send({ key, name: 'Sprints' }).expect(201)
    ).body as { id: string; key: string };
    for (const [user, role] of [
      [dev, 'DEVELOPER'],
      [viewer, 'VIEWER'],
    ] as const) {
      await t.http
        .post(`/api/v1/projects/${project.id}/members`)
        .set(pm.auth)
        .send({ email: user.email, role })
        .expect(201);
    }
    return { project, pm, dev, viewer, outsider };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  async function sprint(w: World, name = `Sprint ${uid()}`) {
    const res = await t.http
      .post(`/api/v1/projects/${w.project.id}/sprints`)
      .set(w.pm.auth)
      .send({ name, startDate: today(), endDate: inDays(13) })
      .expect(201);
    return res.body as SprintBody & { name: string };
  }

  async function issue(w: World, points: number, extra: Record<string, unknown> = {}) {
    const res = await t.http
      .post(`/api/v1/projects/${w.project.id}/issues`)
      .set(w.pm.auth)
      .send({ title: `Issue ${uid()}`, storyPoints: points, status: 'TODO', ...extra })
      .expect(201);
    return res.body as { id: string; key: string; version: number };
  }

  const add = (w: World, sprintId: string, issueIds: string[]) =>
    t.http.post(`/api/v1/sprints/${sprintId}/issues`).set(w.pm.auth).send({ issueIds });

  async function setStatus(w: World, id: string, path: string[]) {
    for (const status of path) {
      const current = (await t.http.get(`/api/v1/issues/${id}`).set(w.pm.auth)).body as {
        version: number;
      };
      await t.http
        .patch(`/api/v1/issues/${id}`)
        .set(w.pm.auth)
        .send({ version: current.version, status })
        .expect(200);
    }
  }

  describe('planning', () => {
    it('lets project managers create sprints, with validation, and hides them from outsiders', async () => {
      const w = await world();
      const created = await sprint(w, 'Sprint 1');
      expect(created).toMatchObject({ status: 'PLANNED', issueCount: 0, startDate: today() });

      const body = { name: 'Sprint 2', startDate: today(), endDate: inDays(13) };
      const url = `/api/v1/projects/${w.project.id}/sprints`;
      await t.http.post(url).set(w.dev.auth).send(body).expect(403);
      await t.http.post(url).set(w.viewer.auth).send(body).expect(403);
      await t.http.post(url).set(w.outsider.auth).send(body).expect(404);
      await t.http.get(url).set(w.outsider.auth).expect(404);

      const dup = await t.http
        .post(url)
        .set(w.pm.auth)
        .send({ ...body, name: 'Sprint 1' });
      expect(dup.status).toBe(409);
      expect(dup.body.errors[0]).toMatchObject({ path: 'name' });
      const backwards = await t.http
        .post(url)
        .set(w.pm.auth)
        .send({ ...body, endDate: inDays(-1) });
      expect(backwards.status).toBe(400);
      expect(backwards.body.errors[0]).toMatchObject({ path: 'endDate' });

      // Viewers can read the plan.
      const list = await t.http.get(url).set(w.viewer.auth).expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('adds issues, moves an issue between planned sprints, and filters the issue list', async () => {
      const w = await world();
      const [s1, s2] = [await sprint(w), await sprint(w)];
      const [a, b, c] = [await issue(w, 3), await issue(w, 5), await issue(w, 2)];

      const after = await add(w, s1.id, [a.id, b.id]).expect(200);
      expect(after.body).toMatchObject({ issueCount: 2, points: { total: 8, done: 0 } });
      await add(w, s1.id, [a.id]).expect(200); // already there: no-op

      // Moving b to s2 closes its s1 membership and records the move.
      await add(w, s2.id, [b.id]).expect(200);
      const rows = await t.prisma.sprintIssue.findMany({
        where: { issueId: b.id },
        orderBy: { id: 'asc' },
      });
      expect(rows.map((r) => [r.sprintId, r.outcome])).toEqual([
        [s1.id, 'REMOVED'],
        [s2.id, null],
      ]);
      const history = await t.http.get(`/api/v1/issues/${b.id}/events`).set(w.pm.auth);
      expect(
        history.body.filter((e: { type: string }) => e.type === 'SPRINT_CHANGED'),
      ).toHaveLength(2);

      const list = (q: string) =>
        t.http
          .get(`/api/v1/projects/${w.project.id}/issues?${q}`)
          .set(w.viewer.auth)
          .then((r) => r.body.data as { key: string; sprint: { id: string } | null }[]);
      expect((await list(`sprint=${s1.id}`)).map((i) => i.key)).toEqual([a.key]);
      expect((await list('sprint=none')).map((i) => i.key)).toEqual([c.key]);
      expect((await list(`sprint=${s2.id}`))[0]?.sprint).toEqual({ id: s2.id, name: s2.name });

      // Issues from other projects or unknown ids are rejected as a field error.
      const other = await world();
      const foreign = await issue(other, 1);
      const bad = await add(w, s1.id, [foreign.id]).expect(400);
      expect(bad.body.errors[0]).toMatchObject({ path: 'issueIds' });

      await t.http.delete(`/api/v1/sprints/${s1.id}/issues/${a.id}`).set(w.pm.auth).expect(204);
      await t.http.delete(`/api/v1/sprints/${s1.id}/issues/${a.id}`).set(w.pm.auth).expect(404);
      await t.http.delete(`/api/v1/sprints/${s1.id}/issues/not-a-uuid`).set(w.pm.auth).expect(404);
      expect((await list('sprint=none')).map((i) => i.key).sort()).toEqual([a.key, c.key].sort());
    });

    it('deletes only planned sprints, returning their issues to the backlog', async () => {
      const w = await world();
      const s = await sprint(w);
      const a = await issue(w, 3);
      await add(w, s.id, [a.id]).expect(200);
      await t.http.delete(`/api/v1/sprints/${s.id}`).set(w.pm.auth).expect(204);
      expect(await t.prisma.sprintIssue.count({ where: { issueId: a.id } })).toBe(0);

      const active = await sprint(w);
      await t.http.post(`/api/v1/sprints/${active.id}/start`).set(w.pm.auth).expect(200);
      await t.http.delete(`/api/v1/sprints/${active.id}`).set(w.pm.auth).expect(409);
    });
  });

  describe('lifecycle', () => {
    it('allows one active sprint per project, even when two starts race', async () => {
      const w = await world();
      const [s1, s2] = [await sprint(w), await sprint(w)];
      const results = await Promise.all(
        [s1, s2].map((s) => t.http.post(`/api/v1/sprints/${s.id}/start`).set(w.pm.auth)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409);
      expect(loser?.body.detail).toMatch(/is already active/);
      expect(
        await t.prisma.sprint.count({ where: { projectId: w.project.id, status: 'ACTIVE' } }),
      ).toBe(1);

      const winner = results[0]?.status === 200 ? s1 : s2;
      await t.http.post(`/api/v1/sprints/${winner.id}/start`).set(w.pm.auth).expect(409);
      await t.http.post(`/api/v1/sprints/${winner.id}/start`).set(w.dev.auth).expect(403);
    });

    it('completes a sprint: done, dropped and carried-over issues, into a planned sprint', async () => {
      const w = await world();
      const [current, next] = [await sprint(w), await sprint(w)];
      const [done, open, cancelled, deleted] = [
        await issue(w, 5),
        await issue(w, 3),
        await issue(w, 2),
        await issue(w, 1),
      ];
      await add(w, current.id, [done.id, open.id, cancelled.id, deleted.id]).expect(200);
      await t.http.post(`/api/v1/sprints/${current.id}/start`).set(w.pm.auth).expect(200);

      await setStatus(w, done.id, ['IN_PROGRESS', 'DONE']);
      await setStatus(w, open.id, ['IN_PROGRESS']);
      await setStatus(w, cancelled.id, ['CANCELLED']);
      await t.http.delete(`/api/v1/issues/${deleted.id}`).set(w.pm.auth).expect(204);

      // Only a planned sprint in this project can receive the open issues.
      const other = await sprint(await world());
      const complete = (body: object) =>
        t.http.post(`/api/v1/sprints/${current.id}/complete`).set(w.pm.auth).send(body);
      await complete({ moveOpenIssuesTo: other.id }).expect(400);
      await complete({ moveOpenIssuesTo: current.id }).expect(400);
      await t.http.post(`/api/v1/sprints/${next.id}/complete`).set(w.pm.auth).send({}).expect(409);

      const res = await complete({ moveOpenIssuesTo: next.id }).expect(200);
      expect(res.body).toMatchObject({
        completed: 1,
        movedToBacklog: 0,
        movedToSprint: 1,
        sprint: { status: 'COMPLETED', issueCount: 2, points: { total: 8, done: 5 } },
      });

      const outcomes = await t.prisma.sprintIssue.findMany({
        where: { sprintId: current.id },
        select: { issueId: true, outcome: true },
      });
      expect(Object.fromEntries(outcomes.map((o) => [o.issueId, o.outcome]))).toEqual({
        [done.id]: 'COMPLETED',
        [open.id]: 'CARRIED_OVER',
        [cancelled.id]: 'REMOVED',
        [deleted.id]: 'REMOVED',
      });
      const nextSprint = await t.http.get(`/api/v1/sprints/${next.id}`).set(w.viewer.auth);
      expect(nextSprint.body).toMatchObject({ issueCount: 1, points: { total: 3 } });

      // History is now fixed.
      await complete({}).expect(409);
      await t.http
        .patch(`/api/v1/sprints/${current.id}`)
        .set(w.pm.auth)
        .send({ name: 'x' })
        .expect(409);
      await add(w, current.id, [done.id]).expect(409);

      // Both lifecycle changes were recorded for notifications.
      const outbox = await t.prisma.outboxEvent.findMany({
        where: { aggregateType: 'sprint', aggregateId: current.id },
        orderBy: { id: 'asc' },
      });
      expect(outbox.map((e) => e.eventType)).toEqual(['sprint.started', 'sprint.completed']);
    });

    it('sends open issues to the backlog by default', async () => {
      const w = await world();
      const s = await sprint(w);
      const a = await issue(w, 3);
      await add(w, s.id, [a.id]).expect(200);
      await t.http.post(`/api/v1/sprints/${s.id}/start`).set(w.pm.auth).expect(200);
      const res = await t.http
        .post(`/api/v1/sprints/${s.id}/complete`)
        .set(w.pm.auth)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({ completed: 0, movedToBacklog: 1 });
      const backlog = await t.http
        .get(`/api/v1/projects/${w.project.id}/issues?sprint=none`)
        .set(w.pm.auth);
      expect(backlog.body.data.map((i: { id: string }) => i.id)).toEqual([a.id]);
    });

    it('is read-only in archived projects', async () => {
      const w = await world();
      const s = await sprint(w);
      await t.http.post(`/api/v1/projects/${w.project.id}/archive`).set(w.pm.auth).expect(200);
      await t.http.post(`/api/v1/sprints/${s.id}/start`).set(w.pm.auth).expect(409);
      await t.http.get(`/api/v1/sprints/${s.id}`).set(w.pm.auth).expect(200);
    });
  });

  describe('reports', () => {
    it('builds a burndown from issue history', async () => {
      const w = await world();
      const s = await sprint(w);
      const [a, b] = [await issue(w, 5), await issue(w, 3)];
      await add(w, s.id, [a.id, b.id]).expect(200);

      const planned = await t.http.get(`/api/v1/sprints/${s.id}/burndown`).set(w.viewer.auth);
      expect(planned.body).toMatchObject({ committed: 8 });
      expect(planned.body.days).toHaveLength(14);
      expect(planned.body.days[0].remaining).toBeNull();

      await t.http.post(`/api/v1/sprints/${s.id}/start`).set(w.pm.auth).expect(200);
      await setStatus(w, a.id, ['IN_PROGRESS', 'DONE']);
      const c = await issue(w, 2);
      await add(w, s.id, [c.id]).expect(200); // scope added mid-sprint

      const res = await t.http.get(`/api/v1/sprints/${s.id}/burndown`).set(w.viewer.auth);
      expect(res.body.committed).toBe(8);
      expect(res.body.days[0]).toMatchObject({
        date: today(),
        remaining: 5,
        scopeChange: 2,
        ideal: 8,
      });
      expect(res.body.days[1].remaining).toBeNull(); // tomorrow
      expect(res.body.days[13].ideal).toBe(0);
    });

    it('reports velocity over completed sprints', async () => {
      const w = await world();
      for (const [committed, finished] of [
        [8, 5],
        [6, 6],
      ] as const) {
        const s = await sprint(w);
        const a = await issue(w, finished);
        const extra = committed - finished > 0 ? [await issue(w, committed - finished)] : [];
        await add(w, s.id, [a.id, ...extra.map((e) => e.id)]).expect(200);
        await t.http.post(`/api/v1/sprints/${s.id}/start`).set(w.pm.auth).expect(200);
        await setStatus(w, a.id, ['IN_PROGRESS', 'DONE']);
        await t.http.post(`/api/v1/sprints/${s.id}/complete`).set(w.pm.auth).send({}).expect(200);
      }
      const res = await t.http
        .get(`/api/v1/projects/${w.project.id}/velocity?sprints=5`)
        .set(w.viewer.auth)
        .expect(200);
      expect(
        res.body.sprints.map((s: { committed: number; completed: number }) => [
          s.committed,
          s.completed,
        ]),
      ).toEqual([
        [8, 5],
        [6, 6],
      ]);
      expect(res.body.average).toBe(5.5);
    });
  });
});
