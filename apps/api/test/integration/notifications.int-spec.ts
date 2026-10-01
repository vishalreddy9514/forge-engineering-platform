import { ConfigService } from '@nestjs/config';
import { type Job, Queue } from 'bullmq';

import { EmailProducer } from '../../src/mail/email.producer';
import { NotificationFanout } from '../../src/notifications/notification-fanout.service';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { OutboxRelay } from '../../src/outbox/outbox.relay';
import type { OutboxJob } from '../../src/outbox/outbox.events';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

describe('outbox relay and notifications (real Postgres + Redis)', () => {
  let t: TestApp;
  let queue: Queue;
  let indexingQueue: Queue;
  let relay: OutboxRelay;
  let fanout: NotificationFanout;

  beforeAll(async () => {
    t = await createTestApp();
    const config = t.app.get(ConfigService);
    queue = new Queue(QUEUES.NOTIFICATIONS, {
      prefix: 'forge',
      connection: { url: config.getOrThrow<string>('REDIS_URL') },
    });
    indexingQueue = new Queue(QUEUES.INDEXING, {
      prefix: 'forge',
      connection: { url: config.getOrThrow<string>('REDIS_URL') },
    });
    relay = new OutboxRelay(t.prisma, config, queue, indexingQueue);
    fanout = new NotificationFanout(t.prisma, new EmailProducer(t.emailQueue), config);
  });

  afterAll(async () => {
    await queue.close();
    await indexingQueue.close();
    await t.close();
  });

  beforeEach(async () => {
    await t.redis.flushdb();
  });

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    dev2: SignedInUser;
    outsider: SignedInUser;
  }

  async function world(): Promise<World> {
    const [pm, dev, dev2, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat Manager' }),
      signIn(t, { displayName: 'Dev One' }),
      signIn(t, { displayName: 'Dev Two' }),
      signIn(t, { displayName: 'Out Sider' }),
    ]);
    const key = `N${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http.post('/api/v1/projects').set(pm.auth).send({ key, name: 'Notify' }).expect(201)
    ).body as { id: string; key: string };
    for (const user of [dev, dev2]) {
      await t.http
        .post(`/api/v1/projects/${project.id}/members`)
        .set(pm.auth)
        .send({ email: user.email, role: 'DEVELOPER' })
        .expect(201);
    }
    return { project, pm, dev, dev2, outsider };
  }

  async function createIssue(w: World, body: Record<string, unknown> = {}) {
    const res = await t.http
      .post(`/api/v1/projects/${w.project.id}/issues`)
      .set(w.pm.auth)
      .send({ title: 'Checkout is slow', ...body })
      .expect(201);
    return res.body as { id: string; key: string; version: number };
  }

  const outboxFor = (issueId: string) =>
    // Search indexing events are covered by search.int-spec.
    t.prisma.outboxEvent.findMany({
      where: { aggregateId: issueId, eventType: { not: 'search.index' } },
      orderBy: { id: 'asc' },
    });

  /** Relays everything pending, then runs this issue's jobs through the fan-out, as the worker would. */
  async function deliver(issueId: string): Promise<void> {
    while ((await relay.drain()) > 0);
    const jobs: Job[] = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
    for (const job of jobs) {
      const data = job.data as { issueId?: string };
      if (data.issueId !== issueId) continue;
      if (job.name === 'issue.assigned') {
        await fanout.issueAssigned(job.data as OutboxJob<'issue.assigned'>);
      } else if (job.name === 'comment.added') {
        await fanout.commentAdded(job.data as OutboxJob<'comment.added'>);
      }
    }
  }

  const notificationsOf = (user: SignedInUser) =>
    t.prisma.notification.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });

  describe('outbox writes', () => {
    it('records an assignment in the same transaction, and nothing for a rejected edit', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      expect(await outboxFor(issue.id)).toEqual([
        expect.objectContaining({
          eventType: 'issue.assigned',
          payload: { issueId: issue.id, assigneeId: w.dev.id, actorId: w.pm.id },
          publishedAt: null,
        }),
      ]);

      // A stale edit rolls back entirely: no history, no outbox row.
      await t.http
        .patch(`/api/v1/issues/${issue.id}`)
        .set(w.pm.auth)
        .send({ version: issue.version + 5, assigneeId: w.dev2.id })
        .expect(409);
      // Unassigning or changing other fields is not an assignment.
      await t.http
        .patch(`/api/v1/issues/${issue.id}`)
        .set(w.pm.auth)
        .send({ version: issue.version, assigneeId: null })
        .expect(200);
      expect(await outboxFor(issue.id)).toHaveLength(1);
    });
  });

  describe('relay', () => {
    it('publishes each row once with a deterministic job ID, and collapses re-publishing', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      while ((await relay.drain()) > 0);

      const [row] = await outboxFor(issue.id);
      expect(row?.publishedAt).toBeInstanceOf(Date);
      const jobId = `outbox-${String(row?.id)}`;
      const job = await queue.getJob(jobId);
      expect(job?.name).toBe('issue.assigned');
      expect(job?.data).toMatchObject({ issueId: issue.id, outboxId: String(row?.id) });

      // Simulate a crash after publishing but before marking the row: it is published again.
      await t.prisma.outboxEvent.update({ where: { id: row?.id }, data: { publishedAt: null } });
      while ((await relay.drain()) > 0);
      const jobs = (await queue.getJobs(['waiting'])).filter((j) => j.id === jobId);
      expect(jobs).toHaveLength(1);
    });

    it('lets several relays run at once without publishing a row twice', async () => {
      const w = await world();
      const issue = await createIssue(w);
      await t.prisma.outboxEvent.createMany({
        data: Array.from({ length: 250 }, () => ({
          aggregateType: 'issue',
          aggregateId: issue.id,
          eventType: 'comment.added',
          payload: { issueId: issue.id, commentId: issue.id, actorId: w.pm.id },
        })),
      });

      const published: string[] = [];
      const recordingQueue = {
        addBulk: async (jobs: { opts?: { jobId?: string } }[]) => {
          for (const job of jobs) published.push(job.opts?.jobId ?? '');
          await new Promise((resolve) => setTimeout(resolve, 20)); // hold the row locks a while
          return [];
        },
      } as unknown as Queue;
      const config = t.app.get(ConfigService);
      const relays = [1, 2, 3].map(
        () => new OutboxRelay(t.prisma, config, recordingQueue, recordingQueue),
      );
      await Promise.all(
        relays.map(async (r) => {
          while ((await r.drain()) > 0);
        }),
      );

      const ours = (await outboxFor(issue.id)).map((row) => `outbox-${String(row.id)}`);
      expect(ours).toHaveLength(250);
      expect(new Set(published).size).toBe(published.length); // no row published twice
      expect(published).toEqual(expect.arrayContaining(ours));
      expect((await outboxFor(issue.id)).every((row) => row.publishedAt !== null)).toBe(true);
    });

    it('runs as a loop: new events are published promptly and shutdown is clean', async () => {
      const w = await world();
      const looping = new OutboxRelay(t.prisma, t.app.get(ConfigService), queue, indexingQueue);
      looping.onApplicationBootstrap();
      try {
        const issue = await createIssue(w, { assigneeId: w.dev.id });
        const deadline = Date.now() + 5_000;
        let published = false;
        while (!published && Date.now() < deadline) {
          const [row] = await outboxFor(issue.id);
          published = Boolean(row?.publishedAt);
          if (!published) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(published).toBe(true);
      } finally {
        await looping.onApplicationShutdown();
      }
    });

    it('prunes rows published more than a week ago', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      while ((await relay.drain()) > 0);
      const [row] = await outboxFor(issue.id);
      await t.prisma.outboxEvent.update({
        where: { id: row?.id },
        data: { publishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
      });
      expect(await relay.prune()).toBeGreaterThanOrEqual(1);
      expect(await outboxFor(issue.id)).toEqual([]);
    });
  });

  describe('fan-out', () => {
    it('notifies the assignee once, even if the event is delivered twice, and emails them', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      await deliver(issue.id);
      await deliver(issue.id); // redelivery

      const [row] = await outboxFor(issue.id);
      await fanout.issueAssigned({
        issueId: issue.id,
        assigneeId: w.dev.id,
        actorId: w.pm.id,
        outboxId: String(row?.id),
      });

      const notes = await notificationsOf(w.dev);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        type: 'ISSUE_ASSIGNED',
        payload: {
          projectKey: w.project.key,
          issueKey: issue.key,
          issueTitle: 'Checkout is slow',
          actorName: 'Pat Manager',
        },
        readAt: null,
      });
      const emails = (await t.emailQueue.getJobs(['waiting'])).filter(
        (j) => j.name === 'issue-assigned' && (j.data as { to: string }).to === w.dev.email,
      );
      expect(emails).toHaveLength(1);
      expect((emails[0]?.data as { issueUrl: string }).issueUrl).toBe(
        `http://localhost:3000/projects/${w.project.key}/issues/${issue.key}`,
      );
    });

    it('skips self-assignment, stale assignments and people who left the project', async () => {
      const w = await world();
      const self = await t.http
        .post(`/api/v1/projects/${w.project.id}/issues`)
        .set(w.dev.auth)
        .send({ title: 'Mine', assigneeId: w.dev.id })
        .expect(201);
      await deliver(self.body.id as string);
      expect(await notificationsOf(w.dev)).toEqual([]);

      // Reassigned before the worker ran: only the current assignee hears about it.
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      await t.http
        .patch(`/api/v1/issues/${issue.id}`)
        .set(w.pm.auth)
        .send({ version: issue.version, assigneeId: w.dev2.id })
        .expect(200);
      await deliver(issue.id);
      expect(await notificationsOf(w.dev)).toEqual([]);
      expect(await notificationsOf(w.dev2)).toHaveLength(1);

      // Removed from the project before delivery.
      const later = await createIssue(w, { assigneeId: w.dev.id });
      await t.http
        .delete(`/api/v1/projects/${w.project.id}/members/${w.dev.id}`)
        .set(w.pm.auth)
        .expect(204);
      await deliver(later.id);
      expect(await notificationsOf(w.dev)).toEqual([]);
    });

    it('tells the people involved about a comment, but not its author', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id }); // reporter: pm
      await t.http
        .post(`/api/v1/issues/${issue.id}/comments`)
        .set(w.dev2.auth)
        .send({ body: 'I can reproduce this' })
        .expect(201);
      await deliver(issue.id);

      const types = async (user: SignedInUser) =>
        (await notificationsOf(user)).map((n) => n.type).sort();
      expect(await types(w.pm)).toEqual(['COMMENT_ADDED']); // reporter
      expect(await types(w.dev)).toEqual(['COMMENT_ADDED', 'ISSUE_ASSIGNED']); // assignee
      expect(await types(w.dev2)).toEqual([]); // the author

      // A later comment by the assignee reaches the earlier commenter too.
      await t.http
        .post(`/api/v1/issues/${issue.id}/comments`)
        .set(w.dev.auth)
        .send({ body: 'Fixed in #12' })
        .expect(201);
      await deliver(issue.id);
      expect(await types(w.dev2)).toEqual(['COMMENT_ADDED']);
      expect(await types(w.pm)).toEqual(['COMMENT_ADDED', 'COMMENT_ADDED']);
    });
  });

  describe('sprint notifications', () => {
    it('tells everyone on the project when a sprint starts or completes, except the actor', async () => {
      const w = await world();
      const today = new Date().toISOString().slice(0, 10);
      const sprint = (
        await t.http
          .post(`/api/v1/projects/${w.project.id}/sprints`)
          .set(w.pm.auth)
          .send({ name: 'Sprint A', startDate: today, endDate: today })
          .expect(201)
      ).body as { id: string };
      await t.http.post(`/api/v1/sprints/${sprint.id}/start`).set(w.pm.auth).expect(200);
      await t.http
        .post(`/api/v1/sprints/${sprint.id}/complete`)
        .set(w.pm.auth)
        .send({})
        .expect(200);

      while ((await relay.drain()) > 0);
      const jobs = (await queue.getJobs(['waiting'])).filter(
        (j) => (j.data as { sprintId?: string }).sprintId === sprint.id,
      );
      expect(jobs.map((j) => j.name).sort()).toEqual(['sprint.completed', 'sprint.started']);
      for (const job of jobs) {
        const type = job.name === 'sprint.started' ? 'SPRINT_STARTED' : 'SPRINT_COMPLETED';
        await fanout.sprintChanged(type, job.data as OutboxJob<'sprint.started'>);
        await fanout.sprintChanged(type, job.data as OutboxJob<'sprint.started'>); // redelivery
      }

      const types = async (user: SignedInUser) =>
        (await notificationsOf(user)).map((n) => n.type).sort();
      expect(await types(w.dev)).toEqual(['SPRINT_COMPLETED', 'SPRINT_STARTED']);
      expect(await types(w.dev2)).toEqual(['SPRINT_COMPLETED', 'SPRINT_STARTED']);
      expect(await types(w.pm)).toEqual([]);
      expect(await types(w.outsider)).toEqual([]);

      const list = await t.http.get('/api/v1/notifications').set(w.dev.auth).expect(200);
      const completed = (list.body.data as { type: string }[]).find(
        (n) => n.type === 'SPRINT_COMPLETED',
      );
      expect(completed).toMatchObject({
        type: 'SPRINT_COMPLETED',
        payload: {
          projectKey: w.project.key,
          sprintId: sprint.id,
          sprintName: 'Sprint A',
          actorName: 'Pat Manager',
        },
      });
    });
  });

  describe('API', () => {
    it('lists your notifications newest first, counts unread and marks them read', async () => {
      const w = await world();
      for (let i = 0; i < 3; i++) {
        const issue = await createIssue(w, { title: `Issue ${String(i)}`, assigneeId: w.dev.id });
        await deliver(issue.id);
      }

      const count = await t.http.get('/api/v1/notifications/unread-count').set(w.dev.auth);
      expect(count.body).toEqual({ count: 3 });

      const page1 = await t.http.get('/api/v1/notifications?limit=2').set(w.dev.auth).expect(200);
      expect(
        page1.body.data.map((n: { payload: { issueTitle: string } }) => n.payload.issueTitle),
      ).toEqual(['Issue 2', 'Issue 1']);
      const page2 = await t.http
        .get(`/api/v1/notifications?limit=2&cursor=${page1.body.nextCursor as string}`)
        .set(w.dev.auth)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const first = page1.body.data[0] as { id: string };
      await t.http.post(`/api/v1/notifications/${first.id}/read`).set(w.dev.auth).expect(204);
      await t.http.post(`/api/v1/notifications/${first.id}/read`).set(w.dev.auth).expect(204);
      const unread = await t.http.get('/api/v1/notifications?unread=true').set(w.dev.auth);
      expect(unread.body.data).toHaveLength(2);

      // Someone else's notification is indistinguishable from a missing one.
      await t.http.post(`/api/v1/notifications/${first.id}/read`).set(w.dev2.auth).expect(404);
      await t.http.post('/api/v1/notifications/not-a-uuid/read').set(w.dev.auth).expect(404);
      expect((await t.http.get('/api/v1/notifications').set(w.dev2.auth)).body.data).toEqual([]);

      await t.http.post('/api/v1/notifications/read-all').set(w.dev.auth).expect(204);
      const after = await t.http.get('/api/v1/notifications/unread-count').set(w.dev.auth);
      expect(after.body).toEqual({ count: 0 });
    });

    it('skips rows whose payload is not in the current shape instead of failing the list', async () => {
      const w = await world();
      const issue = await createIssue(w, { assigneeId: w.dev.id });
      await deliver(issue.id);
      // e.g. written by an older seed or a future event type this build does not know
      await t.prisma.notification.create({
        data: {
          userId: w.dev.id,
          type: 'SPRINT_STARTED',
          payload: { sprint: 'Old', project: 'X' },
        },
      });

      const list = await t.http.get('/api/v1/notifications').set(w.dev.auth).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ type: 'ISSUE_ASSIGNED' });
    });

    it('requires authentication and rejects malformed cursors', async () => {
      await t.http.get('/api/v1/notifications').expect(401);
      const w = await world();
      await t.http.get('/api/v1/notifications?cursor=%%%').set(w.dev.auth).expect(400);
    });
  });
});
