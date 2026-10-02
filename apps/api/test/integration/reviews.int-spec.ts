import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { randomInt } from 'node:crypto';

import { AiJobProcessor } from '../../src/ai/ai-jobs.processor';
import { AiUsageService } from '../../src/ai/ai-usage.service';
import { AiClient } from '../../src/ai/ai.client';
import { PullRequestReviewer } from '../../src/ai/pr-reviewer';
import { GithubClient } from '../../src/github/github.client';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { FakeAiService } from './ai/fake-ai-service';
import { FakeGithub } from './github/fake-github';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const FILES = [
  {
    filename: 'app/db.py',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch:
      '@@ -40,2 +42,3 @@\n-    old\n+    sql = "SELECT * FROM t WHERE n = \'" + n + "\'"\n+    return db.run(sql)',
  },
  {
    filename: 'pnpm-lock.yaml',
    status: 'modified',
    additions: 900,
    deletions: 850,
    patch: '@@ -1 +1 @@\n-a\n+b',
  },
  { filename: 'docs/logo.png', status: 'added', additions: 0, deletions: 0 },
];

describe('AI code review (fake GitHub + fake AI service, real Postgres + Redis)', () => {
  let t: TestApp;
  let ai: FakeAiService;
  let github: FakeGithub;
  let queue: Queue;
  let processor: AiJobProcessor;
  let installationId: number;

  beforeAll(async () => {
    t = await createTestApp();
    const config = t.app.get(ConfigService);
    ai = new FakeAiService(config.getOrThrow<string>('AI_SERVICE_TOKEN'));
    await ai.listen(config.getOrThrow<string>('AI_SERVICE_URL'));
    github = new FakeGithub(4242, config.getOrThrow<string>('INTEGRATION_GITHUB_PUBLIC_KEY'));
    await github.listen(config.getOrThrow<string>('GITHUB_API_URL'));
    queue = t.app.get<Queue>(getQueueToken(QUEUES.AI));
    processor = new AiJobProcessor(
      t.prisma,
      t.app.get(AiClient),
      t.app.get(AiUsageService),
      new PullRequestReviewer(
        t.prisma,
        t.app.get(GithubClient),
        t.app.get(AiClient),
        t.app.get(AiUsageService),
      ),
    );
  });

  afterAll(async () => {
    await ai.close();
    await github.close();
    await t.close();
  });

  let head = SHA_A;
  let files = FILES;
  beforeEach(async () => {
    ai.mode = 'ok';
    ai.requests.length = 0;
    github.reset();
    head = SHA_A;
    files = FILES;
    await queue.obliterate({ force: true });
    await t.redis.flushdb();
    // The pull request as GitHub reports it now: head commit and changed files.
    github.override((req) => {
      if (/\/pulls\/41$/.test(req.path))
        return { status: 200, body: { number: 41, head: { sha: head } } };
      if (/\/pulls\/41\/files$/.test(req.path)) return { status: 200, body: files };
      return null;
    });
  });

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
    pr: { id: string };
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer] = await Promise.all([
      signIn(t, { displayName: 'Pat Manager' }),
      signIn(t, { displayName: 'Dee Developer' }),
      signIn(t, { displayName: 'Vic Viewer' }),
    ]);
    const key = `R${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http
        .post('/api/v1/projects')
        .set(pm.auth)
        .send({ key, name: 'Review project' })
        .expect(201)
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
    installationId = randomInt(10_000, 2 ** 30);
    github.addInstallation(installationId, 'acme');
    const installation = await t.prisma.githubInstallation.create({
      data: { installationId, accountLogin: 'acme', accountType: 'ORGANIZATION' },
    });
    const repo = await t.prisma.githubRepository.create({
      data: {
        installationId: installation.id,
        githubId: randomInt(1, 2 ** 31),
        fullName: 'acme/pay',
        defaultBranch: 'main',
        isPrivate: true,
        htmlUrl: 'https://github.com/acme/pay',
        projects: { create: { projectId: project.id } },
      },
    });
    const pr = await t.prisma.githubPullRequest.create({
      data: {
        repositoryId: repo.id,
        githubId: randomInt(1, 2 ** 31),
        number: 41,
        title: 'Look up users by name',
        body: 'Adds a query.',
        state: 'OPEN',
        headRef: 'feature/lookup',
        headSha: SHA_A,
        baseRef: 'main',
        htmlUrl: 'https://github.com/acme/pay/pull/41',
        openedAt: new Date(),
        githubUpdatedAt: new Date(),
      },
    });
    return { project, pm, dev, viewer, pr };
  }

  const base = (w: World) => `/api/v1/projects/${w.project.id}/pull-requests/${w.pr.id}`;
  const requestReview = (w: World, as: SignedInUser) =>
    t.http.post(`${base(w)}/ai/reviews`).set(as.auth);

  async function runJobs(): Promise<unknown[]> {
    const jobs: Job[] = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
    const outcomes: unknown[] = [];
    for (const job of jobs) {
      outcomes.push(await processor.process(job).catch((error: unknown) => error));
      await job.remove();
    }
    return outcomes;
  }

  it('queues a review, reviews the current head, and stores what was and was not reviewed', async () => {
    const w = await world();

    const queued = await requestReview(w, w.dev).expect(202);
    expect(queued.body).toMatchObject({
      status: 'queued',
      job: { type: 'PR_REVIEW', status: 'QUEUED' },
    });
    const audit = await t.prisma.auditLog.findMany({
      where: { action: 'ai.review.requested', entityId: w.pr.id },
    });
    expect(audit).toEqual([
      expect.objectContaining({ actorId: w.dev.id, entityType: 'pull_request' }),
    ]);

    await runJobs();

    // Only reviewable files went to the AI service, with their patches.
    const sent = ai.requests.find((r) => r.path === '/v1/reviews')?.body as {
      files: { path: string }[];
      omittedFiles: { path: string; reason: string }[];
      pullRequest: { number: number; repository: string };
    };
    expect(sent.files.map((f) => f.path)).toEqual(['app/db.py']);
    expect(sent.omittedFiles).toEqual([
      { path: 'pnpm-lock.yaml', reason: 'lockfile' },
      { path: 'docs/logo.png', reason: 'binary or too large to diff' },
    ]);
    expect(sent.pullRequest).toMatchObject({ number: 41, repository: 'acme/pay' });

    const review = await t.http
      .get(`${base(w)}/ai/review`)
      .set(w.viewer.auth)
      .expect(200);
    expect(review.body).toMatchObject({
      headSha: SHA_A,
      stale: false,
      promptVersion: 'pr_review@1',
      findings: [
        expect.objectContaining({ severity: 'critical', category: 'security' }),
        expect.anything(),
      ],
      skippedFiles: sent.omittedFiles,
    });
    const usage = await t.prisma.aiUsage.findMany({ where: { userId: w.dev.id } });
    expect(usage).toEqual([expect.objectContaining({ feature: 'PR_REVIEW', inputTokens: 3200 })]);
    const [notification] = await t.prisma.notification.findMany({ where: { userId: w.dev.id } });
    expect(notification).toMatchObject({
      type: 'AI_JOB_COMPLETED',
      payload: { repository: 'acme/pay', pullRequestNumber: 41, pullRequestId: w.pr.id },
    });

    // The same commit is never reviewed twice.
    const again = await requestReview(w, w.pm).expect(200);
    expect(again.body).toMatchObject({ status: 'completed', review: { headSha: SHA_A } });
    expect(await queue.getJobs(['waiting'])).toHaveLength(0);
  });

  it('reviews the newest commit, and marks an older review stale', async () => {
    const w = await world();
    head = SHA_B; // pushed after the last sync
    await requestReview(w, w.dev).expect(202);
    await runJobs();

    const review = await t.http
      .get(`${base(w)}/ai/review`)
      .set(w.dev.auth)
      .expect(200);
    expect(review.body).toMatchObject({ headSha: SHA_B, stale: false });

    await t.prisma.githubPullRequest.update({
      where: { id: w.pr.id },
      data: { headSha: 'c'.repeat(40) },
    });
    const later = await t.http
      .get(`${base(w)}/ai/review`)
      .set(w.dev.auth)
      .expect(200);
    expect(later.body).toMatchObject({ headSha: SHA_B, stale: true });
    // A new commit can be reviewed again.
    await requestReview(w, w.dev).expect(202);
  });

  it('asks twice, queues once', async () => {
    const w = await world();
    const first = await requestReview(w, w.dev).expect(202);
    const second = await requestReview(w, w.pm).expect(202);
    expect((second.body as { job: { id: string } }).job.id).toBe(
      (first.body as { job: { id: string } }).job.id,
    );
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('records a review of only skipped files without calling the AI service', async () => {
    const w = await world();
    files = [FILES[1] as (typeof FILES)[number]];
    await requestReview(w, w.dev).expect(202);
    await runJobs();
    const review = await t.http
      .get(`${base(w)}/ai/review`)
      .set(w.dev.auth)
      .expect(200);
    expect(review.body).toMatchObject({
      findings: [],
      skippedFiles: [{ path: 'pnpm-lock.yaml', reason: 'lockfile' }],
    });
    expect(ai.requests.filter((r) => r.path === '/v1/reviews')).toHaveLength(0);
  });

  it('retries provider outages, then fails and tells the requester', async () => {
    const w = await world();
    await requestReview(w, w.dev).expect(202);
    ai.mode = 'error_503';
    const [job] = await queue.getJobs(['waiting']);
    if (!job) throw new Error('no job');
    await expect(processor.process(job)).rejects.toThrow(/503/);
    const queuedAgain = await t.prisma.aiJob.findFirstOrThrow({
      where: { type: 'PR_REVIEW', requestedById: w.dev.id },
    });
    expect(queuedAgain.status).toBe('QUEUED');

    job.attemptsMade = 2; // the last of three attempts
    await expect(processor.process(job)).rejects.toThrow();
    const failed = await t.prisma.aiJob.findUniqueOrThrow({ where: { id: queuedAgain.id } });
    expect(failed).toMatchObject({
      status: 'FAILED',
      error: 'The review could not be made. Please try again.',
    });
    const [notification] = await t.prisma.notification.findMany({ where: { userId: w.dev.id } });
    expect(notification?.type).toBe('AI_JOB_FAILED');
  });

  it('enforces permissions and project scope, and refuses work while the AI is down', async () => {
    const w = await world();
    await requestReview(w, w.viewer).expect(403);
    const other = (
      await t.http
        .post('/api/v1/projects')
        .set(w.dev.auth)
        .send({ key: `O${uid().toUpperCase()}`.slice(0, 8), name: 'Other' })
        .expect(201)
    ).body as { id: string };
    // The pull request's repository is not linked to this other project.
    await t.http
      .post(`/api/v1/projects/${other.id}/pull-requests/${w.pr.id}/ai/reviews`)
      .set(w.dev.auth)
      .expect(404);
    await t.http
      .get(`/api/v1/projects/${other.id}/pull-requests/${w.pr.id}`)
      .set(w.dev.auth)
      .expect(404);

    await ai.close();
    try {
      await requestReview(w, w.dev).expect(503);
    } finally {
      await ai.listen(t.app.get(ConfigService).getOrThrow<string>('AI_SERVICE_URL'));
    }
    expect(
      await t.prisma.aiJob.count({ where: { type: 'PR_REVIEW', projectId: w.project.id } }),
    ).toBe(0);
  });

  it('shows the pull request with its description; no review is a 404', async () => {
    const w = await world();
    const detail = await t.http.get(base(w)).set(w.viewer.auth).expect(200);
    expect(detail.body).toMatchObject({
      number: 41,
      body: 'Adds a query.',
      headSha: SHA_A,
      repository: { fullName: 'acme/pay' },
    });
    await t.http
      .get(`${base(w)}/ai/review`)
      .set(w.viewer.auth)
      .expect(404);
  });
});
