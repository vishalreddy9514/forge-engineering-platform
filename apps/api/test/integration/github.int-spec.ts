import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { type Job, type Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { GithubSync } from '../../src/github/github-sync.service';
import { GithubWebhookHandler } from '../../src/github/github-webhook.handler';
import { GithubJobs, GITHUB_JOBS } from '../../src/github/github.jobs';
import { GithubProcessor } from '../../src/github/github.processor';
import { GithubSettings } from '../../src/github/github.settings';
import { signWebhookBody } from '../../src/github/webhook-signature';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { EmailProducer } from '../../src/mail/email.producer';
import { NotificationFanout } from '../../src/notifications/notification-fanout.service';
import type { OutboxJob } from '../../src/outbox/outbox.events';
import { FakeGithub, type FakeRepo, recordedRepo } from './github/fake-github';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

const SECRET = 'integration-webhook-secret-0123456789';

describe('GitHub integration (recorded fixtures, real Postgres + Redis)', () => {
  let t: TestApp;
  let github: FakeGithub;
  let queue: Queue;
  let sync: GithubSync;
  let handler: GithubWebhookHandler;
  let processor: GithubProcessor;
  let admin: SignedInUser;
  let installationId = 90_000 + Math.floor(Math.random() * 1000) * 100;

  beforeAll(async () => {
    t = await createTestApp();
    const config = t.app.get(ConfigService);
    github = new FakeGithub(4242, config.getOrThrow<string>('INTEGRATION_GITHUB_PUBLIC_KEY'));
    await github.listen(config.getOrThrow<string>('GITHUB_API_URL'));
    queue = t.app.get<Queue>(getQueueToken(QUEUES.GITHUB));
    sync = t.app.get(GithubSync);
    const jobs = t.app.get(GithubJobs);
    handler = new GithubWebhookHandler(t.prisma, sync, jobs);
    processor = new GithubProcessor(
      queue,
      t.prisma,
      t.app.get(GithubSettings),
      sync,
      handler,
      jobs,
    );
    admin = await signIn(t, { isAdmin: true, displayName: 'Ada Admin' });
  });

  afterAll(async () => {
    await github.close();
    await t.close();
  });

  beforeEach(async () => {
    github.reset();
    await queue.obliterate({ force: true });
    await t.redis.flushdb();
  });

  // ───────────── helpers ─────────────

  interface World {
    repo: FakeRepo;
    repositoryId: string;
    installationId: number;
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
  }

  async function project(pm: SignedInUser, prefix = 'G') {
    const key = `${prefix}${uid().toUpperCase()}`.slice(0, 8);
    const res = await t.http
      .post('/api/v1/projects')
      .set(pm.auth)
      .send({ key, name: `GitHub ${key}` })
      .expect(201);
    return res.body as { id: string; key: string };
  }

  async function addMember(p: { id: string }, pm: SignedInUser, user: SignedInUser, role: string) {
    await t.http
      .post(`/api/v1/projects/${p.id}/members`)
      .set(pm.auth)
      .send({ email: user.email, role })
      .expect(201);
  }

  async function createIssue(
    p: { id: string },
    as: SignedInUser,
    body: Record<string, unknown> = {},
  ) {
    const res = await t.http
      .post(`/api/v1/projects/${p.id}/issues`)
      .set(as.auth)
      .send({ title: 'Refunds retry', ...body })
      .expect(201);
    return res.body as { id: string; key: string };
  }

  /** Runs every waiting GitHub job through the processor, as the worker would. */
  async function drain(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const jobs: Job[] = await queue.getJobs(['waiting', 'prioritized']);
      if (jobs.length === 0) return;
      for (const job of jobs) {
        await processor.process(job);
        await job.remove();
      }
    }
  }

  /** Installation connected by an admin, synced, and one repository linked to a new project. */
  async function world(configure?: (repo: FakeRepo) => void): Promise<World> {
    installationId += 1;
    const repo = recordedRepo(`platform-${uid()}`);
    configure?.(repo);
    github.addInstallation(installationId, 'forge-fixtures', [repo]);

    await t.http
      .post('/api/v1/github/installations')
      .set(admin.auth)
      .send({ installationId })
      .expect(200);
    await drain(); // installation.sync: repository list

    const [pm, dev, viewer] = await Promise.all([
      signIn(t, { displayName: 'Pat Manager' }),
      signIn(t, { displayName: 'Dee Developer' }),
      signIn(t, { displayName: 'Vic Viewer' }),
    ]);
    const p = await project(pm);
    await addMember(p, pm, dev, 'DEVELOPER');
    await addMember(p, pm, viewer, 'VIEWER');

    const available = await t.http
      .get(`/api/v1/projects/${p.id}/github/available-repositories`)
      .set(pm.auth)
      .expect(200);
    const repository = (available.body as { id: string; fullName: string }[]).find(
      (r) => r.fullName === repo.repository.full_name,
    );
    if (!repository) throw new Error('repository not synced from the installation');
    return { repo, repositoryId: repository.id, installationId, project: p, pm, dev, viewer };
  }

  async function link(w: World) {
    const res = await t.http
      .post(`/api/v1/projects/${w.project.id}/repositories`)
      .set(w.pm.auth)
      .send({ repositoryId: w.repositoryId })
      .expect(201);
    return res.body as { syncStatus: string };
  }

  function webhook(event: string, payload: unknown, deliveryId = randomUUID()) {
    const body = JSON.stringify(payload);
    return t.http
      .post('/api/v1/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', event)
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', signWebhookBody(SECRET, body))
      .send(body);
  }

  /** Mentions are what the tests control; everything else in the fixtures is as recorded. */
  function mention(repo: FakeRepo, number: number, fields: Record<string, unknown>) {
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${String(number)} in the fixtures`);
    Object.assign(pr, fields);
    return pr;
  }

  const pullRequests = (w: World, query = '') =>
    t.http
      .get(`/api/v1/projects/${w.project.id}/pull-requests${query}`)
      .set(w.viewer.auth)
      .expect(200)
      .then(
        (res) =>
          res.body as {
            data: { number: number; state: string; issueKeys: string[] }[];
            nextCursor: string | null;
          },
      );

  // ───────────── webhooks ─────────────

  describe('webhook endpoint', () => {
    it('rejects deliveries without a valid signature over the exact body', async () => {
      const body = JSON.stringify({ zen: 'Design for failure.' });
      const send = (signature?: string) => {
        const req = t.http
          .post('/api/v1/webhooks/github')
          .set('content-type', 'application/json')
          .set('x-github-event', 'ping')
          .set('x-github-delivery', randomUUID());
        return (signature ? req.set('x-hub-signature-256', signature) : req).send(body);
      };
      await send().expect(401);
      await send(signWebhookBody('some-other-secret-value', body)).expect(401);
      // Signed over different bytes (the same JSON, re-serialised).
      await send(signWebhookBody(SECRET, JSON.stringify(JSON.parse(body), null, 1))).expect(401);
      expect(await t.prisma.githubWebhookDelivery.count({ where: { event: 'ping' } })).toBe(0);
    });

    it('stores a delivery once, answers 202, and queues one job even when GitHub redelivers', async () => {
      const deliveryId = randomUUID();
      const payload = { zen: 'Keep it logically awesome.', hook_id: 1 };
      const first = await webhook('ping', payload, deliveryId).expect(202);
      expect(first.body).toEqual({ received: true, duplicate: false });
      const again = await webhook('ping', payload, deliveryId).expect(202);
      expect(again.body).toEqual({ received: true, duplicate: true });

      expect(await t.prisma.githubWebhookDelivery.count({ where: { id: deliveryId } })).toBe(1);
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.map((j) => j.id)).toEqual([`delivery-${deliveryId}`]);

      await drain();
      const stored = await t.prisma.githubWebhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(stored.processedAt).not.toBeNull();
      // Processed: a later redelivery is acknowledged without queueing anything.
      await webhook('ping', payload, deliveryId).expect(202);
      expect(await queue.getJobs(['waiting'])).toHaveLength(0);
    });

    it('rejects a missing delivery ID and a signed body that is not JSON', async () => {
      const body = 'not json';
      await t.http
        .post('/api/v1/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'ping')
        .set('x-hub-signature-256', signWebhookBody(SECRET, body))
        .send(body)
        .expect(400);
      await t.http
        .post('/api/v1/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'ping')
        .set('x-github-delivery', randomUUID())
        .set('x-hub-signature-256', signWebhookBody(SECRET, body))
        .send(body)
        .expect(400);
    });
  });

  // ───────────── installations and linking ─────────────

  describe('installations and repository links', () => {
    it('connects an installation only after GitHub confirms it, and syncs its repositories', async () => {
      const user = await signIn(t);
      await t.http
        .post('/api/v1/github/installations')
        .set(user.auth)
        .send({ installationId: 1 })
        .expect(403);
      // Not an installation of this App: GitHub (as the App) answers 404, nothing is stored.
      await t.http
        .post('/api/v1/github/installations')
        .set(admin.auth)
        .send({ installationId: 12345 })
        .expect(404);

      installationId += 1;
      const repos = [
        recordedRepo(`a-${uid()}`),
        recordedRepo(`b-${uid()}`),
        recordedRepo(`c-${uid()}`),
      ];
      github.addInstallation(installationId, 'forge-fixtures', repos);
      github.pageSize = 2; // three repositories over two pages
      const res = await t.http
        .post('/api/v1/github/installations')
        .set(admin.auth)
        .send({ installationId })
        .expect(200);
      expect(res.body).toMatchObject({ installationId, accountLogin: 'forge-fixtures' });

      // The API minted the App JWT; the fake verified its RS256 signature and claims.
      expect(
        github.requestsTo(`/app/installations/${String(installationId)}`).length,
      ).toBeGreaterThan(0);

      await drain();
      const list = await t.http.get('/api/v1/github/installations').set(admin.auth).expect(200);
      const mine = (
        list.body as { installationId: number; repositories: { fullName: string }[] }[]
      ).find((i) => i.installationId === installationId);
      expect(mine?.repositories.map((r) => r.fullName).sort()).toEqual(
        repos.map((r) => r.repository.full_name as string).sort(),
      );
      expect(github.requestsTo('/installation/repositories')).toHaveLength(2);

      // A repository removed from the installation on GitHub disappears from Forge.
      const installation = github.installations.get(installationId);
      installation?.repos.pop();
      await sync.syncInstallation(installationId);
      const after = await t.prisma.githubRepository.count({
        where: { installation: { installationId: BigInt(installationId) } },
      });
      expect(after).toBe(2);
    });

    it('lets project managers link repositories; others can only read', async () => {
      const w = await world();
      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories`)
        .set(w.dev.auth)
        .send({ repositoryId: w.repositoryId })
        .expect(403);
      expect((await link(w)).syncStatus).toBe('QUEUED');
      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories`)
        .set(w.pm.auth)
        .send({ repositoryId: w.repositoryId })
        .expect(409);

      const linked = await t.http
        .get(`/api/v1/projects/${w.project.id}/repositories`)
        .set(w.viewer.auth)
        .expect(200);
      expect(linked.body).toEqual([
        expect.objectContaining({ id: w.repositoryId, fullName: w.repo.repository.full_name }),
      ]);
      const available = await t.http
        .get(`/api/v1/projects/${w.project.id}/github/available-repositories`)
        .set(w.pm.auth)
        .expect(200);
      expect((available.body as { id: string }[]).map((r) => r.id)).not.toContain(w.repositoryId);

      // Developers may ask for a sync; viewers may not; outsiders do not see the project.
      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories/${w.repositoryId}/sync`)
        .set(w.dev.auth)
        .expect(202);
      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories/${w.repositoryId}/sync`)
        .set(w.viewer.auth)
        .expect(403);
      const outsider = await signIn(t);
      await t.http
        .get(`/api/v1/projects/${w.project.id}/repositories`)
        .set(outsider.auth)
        .expect(404);
    });

    it('treats archived projects as read-only', async () => {
      const w = await world();
      await t.http.post(`/api/v1/projects/${w.project.id}/archive`).set(w.pm.auth).expect(200);
      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories`)
        .set(w.pm.auth)
        .send({ repositoryId: w.repositoryId })
        .expect(409);
    });
  });

  // ───────────── sync from recorded responses ─────────────

  describe('repository sync', () => {
    it('mirrors the recorded PRs, commits, issues and contributors, and links mentions', async () => {
      const other = await signIn(t, { displayName: 'Other PM' });
      const otherProject = await project(other, 'O');
      // Exists, but in a project the repository is not linked to.
      const elsewhere = await createIssue(otherProject, other);

      const w = await world((repo) => {
        // A GitHub issue alongside the recorded PR-issues (the fixture repo has none of its own).
        const [first] = repo.issues;
        repo.issues.push({
          ...first,
          id: (first?.id as number) + 500,
          number: 100,
          title: 'Webhook retries are not idempotent',
          pull_request: undefined,
          labels: [{ name: 'bug' }],
        });
      });
      const issue1 = await createIssue(w.project, w.pm);
      const issue2 = await createIssue(w.project, w.pm, { title: 'Second' });
      const deleted = await createIssue(w.project, w.pm, { title: 'Deleted' });
      await t.http.delete(`/api/v1/issues/${deleted.id}`).set(w.pm.auth).expect(204);

      mention(w.repo, 7, { title: `Phase 6b (${issue1.key})` });
      mention(w.repo, 6, {
        body: `Refs ${issue1.key}, ${deleted.key} and ${otherProject.key}-1`,
      });
      mention(w.repo, 5, {
        head: { ...(mention(w.repo, 5, {}).head as object), ref: `feature/${issue2.key}-projects` },
      });
      const commit = w.repo.commits[1] as { commit: { message: string } };
      commit.commit.message = `${issue2.key}: ${commit.commit.message}`;
      github.pageSize = 3; // 8 recorded PRs over three pages

      await link(w);
      await drain();

      const repoRow = await t.prisma.githubRepository.findUniqueOrThrow({
        where: { id: w.repositoryId },
      });
      expect(repoRow).toMatchObject({ syncStatus: 'IDLE', lastSyncError: null });
      expect(repoRow.lastSyncedAt).not.toBeNull();

      // Everything recorded arrived, with GitHub's states mapped (merged PRs are MERGED).
      const all = await pullRequests(w, '?limit=100');
      expect(all.data).toHaveLength(8);
      const byNumber = new Map(all.data.map((p) => [p.number, p]));
      expect(byNumber.get(8)?.state).toBe('OPEN');
      expect(byNumber.get(2)?.state).toBe('OPEN');
      expect(byNumber.get(7)?.state).toBe('MERGED');
      expect((await pullRequests(w, '?state=MERGED&limit=100')).data).toHaveLength(6);

      // Mentions link only to live issues of projects this repository is linked to.
      expect(byNumber.get(7)?.issueKeys).toEqual([issue1.key]);
      expect(byNumber.get(6)?.issueKeys).toEqual([issue1.key]);
      expect(byNumber.get(5)?.issueKeys).toEqual([issue2.key]);
      expect(await t.prisma.issueLink.count({ where: { issueId: deleted.id } })).toBe(0);
      expect(await t.prisma.issueLink.count({ where: { issueId: elsewhere.id } })).toBe(0);

      const commits = await t.http
        .get(`/api/v1/projects/${w.project.id}/commits?limit=100`)
        .set(w.viewer.auth)
        .expect(200);
      expect((commits.body as { data: unknown[] }).data).toHaveLength(7);

      const ghIssues = await t.http
        .get(`/api/v1/projects/${w.project.id}/github-issues`)
        .set(w.viewer.auth)
        .expect(200);
      // The issues endpoint lists the 8 PRs too; only the real issue is stored as an issue.
      expect((ghIssues.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({ number: 100, state: 'OPEN', labels: ['bug'] }),
      ]);

      const [linked] = (
        await t.http.get(`/api/v1/projects/${w.project.id}/repositories`).set(w.pm.auth).expect(200)
      ).body as { counts: Record<string, number>; contributors: { login: string }[] }[];
      expect(linked?.counts).toEqual({ openPullRequests: 2, commits: 7, openIssues: 1 });
      expect(linked?.contributors.map((c) => c.login)).toEqual(['vishalreddy9514', 'sam-okafor']);

      // The issue page's Development panel.
      const dev1 = await t.http
        .get(`/api/v1/issues/${issue1.id}/development`)
        .set(w.viewer.auth)
        .expect(200);
      expect(
        (dev1.body as { pullRequests: { number: number }[] }).pullRequests.map((p) => p.number),
      ).toEqual([7, 6]);
      const dev2 = await t.http
        .get(`/api/v1/issues/${issue2.id}/development`)
        .set(w.viewer.auth)
        .expect(200);
      expect(dev2.body).toMatchObject({
        pullRequests: [expect.objectContaining({ number: 5 })],
        commits: [expect.objectContaining({ sha: (w.repo.commits[1] as { sha: string }).sha })],
      });
    });

    it('pages through PRs with a stable cursor', async () => {
      const w = await world();
      await link(w);
      await drain();
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await pullRequests(w, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.data.map((p) => p.number));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      await t.http
        .get(`/api/v1/projects/${w.project.id}/pull-requests?cursor=bm9wZQ`)
        .set(w.viewer.auth)
        .expect(400);
    });

    it('syncs incrementally after the first run', async () => {
      const w = await world();
      await link(w);
      await drain();
      github.requests.length = 0;

      await t.http
        .post(`/api/v1/projects/${w.project.id}/repositories/${w.repositoryId}/sync`)
        .set(w.pm.auth)
        .expect(202);
      await drain();

      // Commits and issues are asked for changes since the last sync; PR listing stops at the
      // first PR older than that (all recorded PRs are), so one page is read.
      const since = (path: string) => github.requestsTo(path)[0]?.query.get('since');
      expect(since(`/repos/${String(w.repo.repository.full_name)}/commits`)).toBeTruthy();
      expect(since(`/repos/${String(w.repo.repository.full_name)}/issues`)).toBeTruthy();
      expect(github.requestsTo(`/repos/${String(w.repo.repository.full_name)}/pulls`)).toHaveLength(
        1,
      );
    });

    it('re-links stored history when the repository is linked to another project', async () => {
      const w = await world();
      await link(w);
      await drain();

      const second = await project(w.pm, 'S');
      const issue = await createIssue(second, w.pm);
      // Mentioned by a PR already stored, then an unchanged incremental sync would never see it.
      await t.prisma.githubPullRequest.updateMany({
        where: { repositoryId: w.repositoryId, number: 4 },
        data: { title: `Auth (${issue.key})` },
      });
      await t.http
        .post(`/api/v1/projects/${second.id}/repositories`)
        .set(w.pm.auth)
        .send({ repositoryId: w.repositoryId })
        .expect(201);
      await drain();
      const dev = await t.http
        .get(`/api/v1/issues/${issue.id}/development`)
        .set(w.pm.auth)
        .expect(200);
      expect(
        (dev.body as { pullRequests: { number: number }[] }).pullRequests.map((p) => p.number),
      ).toEqual([4]);

      // Unlinking removes this project's links and hides the repository's data from it.
      await t.http
        .delete(`/api/v1/projects/${second.id}/repositories/${w.repositoryId}`)
        .set(w.pm.auth)
        .expect(204);
      expect(await t.prisma.issueLink.count({ where: { issueId: issue.id } })).toBe(0);
      const prs = await t.http
        .get(`/api/v1/projects/${second.id}/pull-requests`)
        .set(w.pm.auth)
        .expect(200);
      expect((prs.body as { data: unknown[] }).data).toEqual([]);
    });
  });

  // ───────────── webhooks applied ─────────────

  describe('webhook processing', () => {
    function prPayload(w: World, action: string, fields: Record<string, unknown>) {
      const recorded = w.repo.pulls.find((p) => p.number === 8);
      return {
        action,
        pull_request: { ...recorded, ...fields },
        repository: { id: w.repo.repository.id, full_name: w.repo.repository.full_name },
        installation: { id: w.installationId },
      };
    }

    it('links a newly opened PR and notifies the assignee; stale and later edits apply correctly', async () => {
      const w = await world();
      await link(w);
      await drain();
      const issue = await createIssue(w.project, w.pm, { assigneeId: w.dev.id });
      const fanout = new NotificationFanout(
        t.prisma,
        new EmailProducer(t.emailQueue),
        t.app.get(ConfigService),
      );

      const opened = prPayload(w, 'opened', {
        id: (w.repo.repository.id as number) + 77,
        number: 77,
        title: `Retry refunds (${issue.key})`,
        state: 'open',
        created_at: '2026-09-27T12:00:00Z',
        updated_at: '2026-09-27T12:00:00Z',
        additions: 120,
        deletions: 8,
        changed_files: 5,
      });
      await webhook('pull_request', opened).expect(202);
      await drain();

      const pr = await t.prisma.githubPullRequest.findUniqueOrThrow({
        where: { repositoryId_number: { repositoryId: w.repositoryId, number: 77 } },
        include: { issueLinks: true },
      });
      expect(pr).toMatchObject({ state: 'OPEN', additions: 120, changedFiles: 5 });
      expect(pr.issueLinks.map((l) => l.issueId)).toEqual([issue.id]);

      // The outbox event is fanned out to the assignee.
      const events = await t.prisma.outboxEvent.findMany({ where: { aggregateId: pr.id } });
      expect(events.map((e) => e.eventType)).toEqual(['pull_request.opened']);
      const event = events[0];
      if (!event) throw new Error('no outbox event');
      expect(
        await fanout.pullRequestOpened({
          ...(event.payload as OutboxJob<'pull_request.opened'>),
          outboxId: String(event.id),
        }),
      ).toBe(1);
      const inbox = await t.http.get('/api/v1/notifications').set(w.dev.auth).expect(200);
      expect((inbox.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({
          type: 'PULL_REQUEST_OPENED',
          payload: expect.objectContaining({
            issueKey: issue.key,
            repository: w.repo.repository.full_name,
            pullRequestNumber: 77,
            authorLogin: 'vishalreddy9514',
          }),
        }),
      ]);
      // Leave no pending outbox rows behind for relay tests in other files.
      await t.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date() },
      });

      // An older update delivered late is ignored...
      await webhook(
        'pull_request',
        prPayload(w, 'edited', {
          ...opened.pull_request,
          title: 'Stale title',
          updated_at: '2026-09-27T11:00:00Z',
        }),
      ).expect(202);
      await drain();
      expect(
        (await t.prisma.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } })).title,
      ).toBe(`Retry refunds (${issue.key})`);

      // ...a newer one that drops the mention removes the link, and merging is recorded.
      await webhook(
        'pull_request',
        prPayload(w, 'closed', {
          ...opened.pull_request,
          title: 'Retry refunds',
          state: 'closed',
          merged_at: '2026-09-27T13:00:00Z',
          closed_at: '2026-09-27T13:00:00Z',
          updated_at: '2026-09-27T13:00:00Z',
        }),
      ).expect(202);
      await drain();
      const after = await t.prisma.githubPullRequest.findUniqueOrThrow({
        where: { id: pr.id },
        include: { issueLinks: true },
      });
      expect(after).toMatchObject({ state: 'MERGED', title: 'Retry refunds' });
      expect(after.issueLinks).toEqual([]);
      // No new notification for an edit or a close.
      expect(await t.prisma.outboxEvent.count({ where: { aggregateId: pr.id } })).toBe(1);
    });

    it('stores pushed commits once and links their mentions', async () => {
      const w = await world();
      await link(w);
      await drain();
      const issue = await createIssue(w.project, w.pm);
      const sha = 'a'.repeat(39) + '1';
      const push = {
        ref: 'refs/heads/feature/x',
        deleted: false,
        commits: [
          {
            id: sha,
            message: `Fix ${issue.key}: idempotent retries\n\nDetails`,
            timestamp: '2026-09-27T14:00:00+02:00',
            url: `https://github.com/${String(w.repo.repository.full_name)}/commit/${sha}`,
            author: { name: 'Dee Developer', username: 'dee' },
          },
        ],
        repository: { id: w.repo.repository.id, full_name: w.repo.repository.full_name },
      };
      await webhook('push', push).expect(202);
      await webhook('push', push).expect(202); // a second delivery of the same push
      await drain();
      const commits = await t.prisma.githubCommit.findMany({
        where: { repositoryId: w.repositoryId, sha },
        include: { issueLinks: true },
      });
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ authorLogin: 'dee', authorName: 'Dee Developer' });
      expect(commits[0]?.issueLinks.map((l) => l.issueId)).toEqual([issue.id]);
    });

    it('ignores repositories no project has linked, and records malformed payloads', async () => {
      const w = await world(); // not linked
      const deliveryId = randomUUID();
      await webhook('pull_request', prPayload(w, 'opened', {}), deliveryId).expect(202);
      await drain();
      expect(
        await t.prisma.githubPullRequest.count({ where: { repositoryId: w.repositoryId } }),
      ).toBe(0);
      expect(
        (await t.prisma.githubWebhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } }))
          .processedAt,
      ).not.toBeNull();

      const bad = randomUUID();
      await webhook('pull_request', { action: 'opened', pull_request: { id: 'x' } }, bad).expect(
        202,
      );
      const [job] = await queue.getJobs(['waiting']);
      await expect(processor.process(job as Job)).rejects.toThrow(/Malformed payload/);
      const stored = await t.prisma.githubWebhookDelivery.findUniqueOrThrow({ where: { id: bad } });
      expect(stored.processedAt).toBeNull();
      expect(stored.error).toMatch(/pull_request/);
    });

    it('removes an installation and all its data when the App is uninstalled', async () => {
      const w = await world();
      await link(w);
      await drain();
      await webhook('installation', {
        action: 'deleted',
        installation: {
          id: w.installationId,
          account: { login: 'forge-fixtures', type: 'Organization' },
        },
      }).expect(202);
      await drain();
      expect(await t.prisma.githubRepository.count({ where: { id: w.repositoryId } })).toBe(0);
      const linked = await t.http
        .get(`/api/v1/projects/${w.project.id}/repositories`)
        .set(w.pm.auth)
        .expect(200);
      expect(linked.body).toEqual([]);
    });
  });

  // ───────────── rate limits and reconciliation ─────────────

  describe('rate limits (FR-6.5)', () => {
    it('parks a sync that hits the limit until the reset, without failing it', async () => {
      const w = await world();
      const reset = Math.floor(Date.now() / 1000) + 1800;
      const stop = github.override((req) =>
        req.path.endsWith('/pulls')
          ? {
              status: 403,
              body: { message: 'API rate limit exceeded for installation.' },
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
            }
          : null,
      );
      await link(w);

      const worker = new Worker(QUEUES.GITHUB, (job, token) => processor.process(job, token), {
        prefix: 'forge',
        connection: { url: t.app.get(ConfigService).getOrThrow<string>('REDIS_URL') },
      });
      try {
        await waitFor(async () => (await queue.getJobs(['delayed'])).length === 1);
      } finally {
        await worker.close();
        stop();
      }
      const [job] = await queue.getJobs(['delayed']);
      expect(job?.name).toBe(GITHUB_JOBS.SYNC_REPOSITORY);
      expect(job?.attemptsMade).toBe(0); // a rate limit does not use up a retry
      const resumesAt = (job?.timestamp ?? 0) + (job?.delay ?? 0);
      expect(resumesAt).toBeGreaterThanOrEqual(reset * 1000);
      expect(resumesAt).toBeLessThan(reset * 1000 + 35_000);
      const row = await t.prisma.githubRepository.findUniqueOrThrow({
        where: { id: w.repositoryId },
      });
      expect(row.syncStatus).toBe('RATE_LIMITED');
    });

    it('stops background calls at the reserve instead of spending the last requests', async () => {
      const w = await world();
      // 12 left, reserve 10: two more calls, then the sync holds back.
      github.quota.set(w.installationId, {
        remaining: 12,
        reset: Math.floor(Date.now() / 1000) + 600,
      });
      await link(w);
      const [job] = await queue.getJobs(['waiting']);
      await expect(processor.process(job as Job)).rejects.toThrow(/rate limit/);
      const calls = github.requests.filter((r) => r.path.startsWith('/repos/'));
      expect(calls).toHaveLength(2);
      expect(github.quota.get(w.installationId)?.remaining).toBe(10);
    });
  });

  it('fails a sync for good when the installation is gone, instead of retrying', async () => {
    const w = await world();
    await link(w);
    github.installations.delete(w.installationId); // uninstalled on GitHub, no webhook yet
    const [job] = await queue.getJobs(['waiting']);
    // The cached installation token is revoked with the installation: that attempt may be
    // retried (it drops the token), and the retry learns the installation is gone for good.
    await expect(processor.process(job as Job)).rejects.toMatchObject({ status: 401 });
    const error = await processor.process(job as Job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    const row = await t.prisma.githubRepository.findUniqueOrThrow({
      where: { id: w.repositoryId },
    });
    expect(row).toMatchObject({
      syncStatus: 'FAILED',
      lastSyncError: 'The GitHub App is no longer installed on this account',
    });
  });

  it('reconciles linked repositories and stranded deliveries hourly', async () => {
    const w = await world();
    await link(w);
    await drain();
    const strandedId = randomUUID();
    await t.prisma.githubWebhookDelivery.create({
      data: {
        id: strandedId,
        event: 'ping',
        payload: {},
        receivedAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    const result = await processor.reconcile();
    expect(result.repositories).toBeGreaterThanOrEqual(1);
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs.map((j) => j.id)).toContain(`delivery-${strandedId}`);
    expect(
      jobs.some(
        (j) =>
          j.name === GITHUB_JOBS.SYNC_REPOSITORY &&
          (j.data as { repositoryId: string }).repositoryId === w.repositoryId,
      ),
    ).toBe(true);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
