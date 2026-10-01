import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type request from 'supertest';

import { AiUsageService } from '../../src/ai/ai-usage.service';
import { AiClient } from '../../src/ai/ai.client';
import { AiSummaryProcessor } from '../../src/ai/ai-summary.processor';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { FakeAiService } from './ai/fake-ai-service';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

const TEXT = 'Customers are charged twice when the Stripe webhook retries.';

describe('AI assistant (fake AI service, real Postgres + Redis)', () => {
  let t: TestApp;
  let ai: FakeAiService;
  let queue: Queue;
  let processor: AiSummaryProcessor;
  let aiUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    const config = t.app.get(ConfigService);
    aiUrl = config.getOrThrow<string>('AI_SERVICE_URL');
    ai = new FakeAiService(config.getOrThrow<string>('AI_SERVICE_TOKEN'));
    await ai.listen(aiUrl);
    queue = t.app.get<Queue>(getQueueToken(QUEUES.AI));
    processor = new AiSummaryProcessor(t.prisma, t.app.get(AiClient), t.app.get(AiUsageService));
  });

  afterAll(async () => {
    await ai.close();
    await t.close();
  });

  beforeEach(async () => {
    ai.mode = 'ok';
    ai.requests.length = 0;
    await queue.obliterate({ force: true });
    await t.redis.flushdb();
  });

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer] = await Promise.all([
      signIn(t, { displayName: 'Pat Manager' }),
      signIn(t, { displayName: 'Dee Developer' }),
      signIn(t, { displayName: 'Vic Viewer' }),
    ]);
    const key = `A${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http
        .post('/api/v1/projects')
        .set(pm.auth)
        .send({ key, name: 'AI project' })
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
    for (const name of ['bug', 'payments']) {
      await t.http
        .post(`/api/v1/projects/${project.id}/labels`)
        .set(pm.auth)
        .send({ name, color: '#1d76db' })
        .expect(201);
    }
    return { project, pm, dev, viewer };
  }

  /** Reads an SSE response into [event, data] pairs. */
  function events(res: request.Response): [string, Record<string, unknown>][] {
    const raw = typeof res.body === 'string' ? res.body : res.text;
    return raw
      .trim()
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const lines = Object.fromEntries(
          block
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
        ) as { event: string; data: string };
        return [lines.event, JSON.parse(lines.data) as Record<string, unknown>];
      });
  }

  const draft = (w: World, as: SignedInUser, text = TEXT) =>
    t.http
      .post(`/api/v1/projects/${w.project.id}/ai/drafts`)
      .set(as.auth)
      .send({ text })
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          done(null, text);
        });
      });

  async function issueWithThread(w: World) {
    const issue = (
      await t.http
        .post(`/api/v1/projects/${w.project.id}/issues`)
        .set(w.pm.auth)
        .send({ title: 'Double charges', description: 'Webhook retries charge twice.' })
        .expect(201)
    ).body as { id: string; key: string };
    await t.http
      .post(`/api/v1/issues/${issue.id}/comments`)
      .set(w.dev.auth)
      .send({ body: 'We decided to store event IDs.' })
      .expect(201);
    return issue;
  }

  async function runJobs(): Promise<unknown[]> {
    const jobs: Job[] = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
    const outcomes: unknown[] = [];
    for (const job of jobs) {
      outcomes.push(await processor.process(job).catch((error: unknown) => error));
      await job.remove();
    }
    return outcomes;
  }

  // ───────────── drafts ─────────────

  describe('issue drafts (FR-7.1)', () => {
    it('streams deltas then a validated draft, and records the cost', async () => {
      const w = await world();
      const res = await draft(w, w.dev).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      const stream = events(res);
      expect(stream.at(-1)?.[0]).toBe('result');
      expect(stream.slice(0, -1).every(([kind]) => kind === 'delta')).toBe(true);
      const result = stream.at(-1)?.[1] as { draft: { title: string }; droppedLabels: string[] };
      expect(result.draft.title).toBe(
        'Customers are charged twice when the Stripe webhook retries',
      );
      // Internal details (model, usage, prompt version) stay on the server.
      expect(Object.keys(result).sort()).toEqual(['draft', 'droppedLabels']);

      // The AI service got the project's labels and the service token.
      const call = ai.requests.find((r) => r.path === '/v1/drafts');
      expect(call?.body).toEqual({
        text: TEXT,
        projectKey: w.project.key,
        projectName: 'AI project',
        labels: ['bug', 'payments'],
      });
      const usage = await t.prisma.aiUsage.findMany({ where: { userId: w.dev.id } });
      expect(usage).toEqual([
        expect.objectContaining({
          feature: 'ISSUE_DRAFT',
          projectId: w.project.id,
          model: 'fake',
          promptVersion: 'issue_draft@1',
          inputTokens: 400,
          outputTokens: 150,
          success: true,
        }),
      ]);
      // Nothing was created: a draft is only a suggestion.
      expect(await t.prisma.issue.count({ where: { projectId: w.project.id } })).toBe(0);
    });

    it('passes on failures with a safe message and still records what they cost', async () => {
      const w = await world();
      ai.mode = 'provider_unavailable';
      const [kind, data] = events(await draft(w, w.dev).expect(200)).at(-1) ?? [];
      expect(kind).toBe('error');
      expect(data).toEqual({
        code: 'provider_unavailable',
        message: 'The AI provider is busy or unreachable. Please try again in a minute.',
      });
      expect(JSON.stringify(data)).not.toContain('OpenAI');
      const usage = await t.prisma.aiUsage.findFirstOrThrow({ where: { userId: w.dev.id } });
      expect(usage.success).toBe(false);
    });

    it('needs ai:write, and hides the project from non-members', async () => {
      const w = await world();
      await draft(w, w.viewer).expect(403);
      await draft(w, await signIn(t)).expect(404);
      await t.http
        .post(`/api/v1/projects/${w.project.id}/ai/drafts`)
        .set(w.dev.auth)
        .send({ text: 'short' })
        .expect(400);
      expect(ai.requests.filter((r) => r.path === '/v1/drafts')).toHaveLength(0);
    });

    it("stops at the person's daily token budget", async () => {
      const w = await world();
      await t.prisma.aiUsage.create({
        data: {
          userId: w.dev.id,
          projectId: w.project.id,
          feature: 'ISSUE_DRAFT',
          model: 'fake',
          inputTokens: 4000,
          outputTokens: 1000,
          latencyMs: 10,
          costUsd: 0,
          success: true,
        },
      });
      const res = await draft(w, w.dev).expect(429);
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(ai.requests.filter((r) => r.path === '/v1/drafts')).toHaveLength(0);
      // Someone else is not affected.
      await draft(w, w.pm).expect(200);
      const status = await t.http.get('/api/v1/ai/status').set(w.dev.auth).expect(200);
      expect(status.body).toEqual({ available: true, budget: { used: 5000, limit: 5000 } });
    });
  });

  // ───────────── summaries ─────────────

  describe('thread summaries (FR-7.2)', () => {
    it('queues one job per thread version, caches the result and notifies the requester', async () => {
      const w = await world();
      const issue = await issueWithThread(w);

      const first = await t.http
        .post(`/api/v1/issues/${issue.id}/ai/summaries`)
        .set(w.dev.auth)
        .expect(202);
      expect(first.body).toMatchObject({ status: 'queued', job: { status: 'QUEUED' } });
      const jobId = (first.body as { job: { id: string } }).job.id;
      expect(first.body.statusUrl).toBe(`/api/v1/ai/jobs/${jobId}`);
      // Asking again before it runs returns the same job.
      const again = await t.http
        .post(`/api/v1/issues/${issue.id}/ai/summaries`)
        .set(w.pm.auth)
        .expect(202);
      expect(again.body.job.id).toBe(jobId);
      expect(await queue.getJobs(['waiting'])).toHaveLength(1);

      await runJobs();

      const job = await t.http.get(`/api/v1/ai/jobs/${jobId}`).set(w.dev.auth).expect(200);
      expect(job.body).toMatchObject({ status: 'COMPLETED', error: null });
      await t.http.get(`/api/v1/ai/jobs/${jobId}`).set(w.viewer.auth).expect(404);

      const summary = await t.http
        .get(`/api/v1/issues/${issue.id}/ai/summary`)
        .set(w.viewer.auth)
        .expect(200);
      expect(summary.body).toMatchObject({
        stale: false,
        promptVersion: 'thread_summary@1',
        summary: { keyDecisions: ['Sam Okafor: We decided to store event IDs.'] },
      });
      // The AI service saw the thread with author names.
      const call = ai.requests.find((r) => r.path === '/v1/summaries');
      expect(call?.body).toMatchObject({
        issue: { key: issue.key, title: 'Double charges', status: 'BACKLOG' },
        comments: [{ author: 'Dee Developer', body: 'We decided to store event IDs.' }],
      });

      const inbox = await t.http.get('/api/v1/notifications').set(w.dev.auth).expect(200);
      expect(inbox.body.data).toEqual([
        expect.objectContaining({
          type: 'AI_JOB_COMPLETED',
          payload: expect.objectContaining({ issueKey: issue.key, jobId }),
        }),
      ]);
      expect(
        await t.prisma.aiUsage.count({ where: { userId: w.dev.id, feature: 'ISSUE_SUMMARY' } }),
      ).toBe(1);

      // Unchanged thread: the cached summary comes back at once, and no AI call is made.
      ai.requests.length = 0;
      const cached = await t.http
        .post(`/api/v1/issues/${issue.id}/ai/summaries`)
        .set(w.dev.auth)
        .expect(200);
      expect(cached.body.status).toBe('completed');
      expect(ai.requests).toHaveLength(0);

      // A new comment makes it stale, and the next request queues a new job.
      await t.http
        .post(`/api/v1/issues/${issue.id}/comments`)
        .set(w.pm.auth)
        .send({ body: 'Should we backfill?' })
        .expect(201);
      const stale = await t.http
        .get(`/api/v1/issues/${issue.id}/ai/summary`)
        .set(w.dev.auth)
        .expect(200);
      expect(stale.body.stale).toBe(true);
      await t.http.post(`/api/v1/issues/${issue.id}/ai/summaries`).set(w.dev.auth).expect(202);
    });

    it('retries provider outages and gives up with a notification after the last attempt', async () => {
      const w = await world();
      const issue = await issueWithThread(w);
      const queued = await t.http
        .post(`/api/v1/issues/${issue.id}/ai/summaries`)
        .set(w.dev.auth)
        .expect(202);
      const jobId = queued.body.job.id as string;
      ai.mode = 'error_503';

      const [job] = await queue.getJobs(['waiting']);
      if (!job) throw new Error('no job');
      await expect(processor.process(job)).rejects.toThrow(/503/);
      expect((await t.prisma.aiJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
        'QUEUED',
      );

      job.attemptsMade = 2; // the third and last attempt
      const last = await processor.process(job).catch((e: unknown) => e);
      expect(last).toBeInstanceOf(UnrecoverableError);
      const row = await t.prisma.aiJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row).toMatchObject({ status: 'FAILED', attempts: 2 });
      expect(row.error).toBe('The summary could not be made. Please try again.');
      const inbox = await t.http.get('/api/v1/notifications').set(w.dev.auth).expect(200);
      expect(inbox.body.data.map((n: { type: string }) => n.type)).toEqual(['AI_JOB_FAILED']);
    });

    it('fails at once when the AI service rejects the request', async () => {
      const w = await world();
      const issue = await issueWithThread(w);
      await t.http.post(`/api/v1/issues/${issue.id}/ai/summaries`).set(w.dev.auth).expect(202);
      ai.mode = 'error_502';
      const [outcome] = await runJobs();
      expect(outcome).toBeInstanceOf(UnrecoverableError);
    });

    it('lets viewers read summaries but not start them', async () => {
      const w = await world();
      const issue = await issueWithThread(w);
      await t.http.post(`/api/v1/issues/${issue.id}/ai/summaries`).set(w.viewer.auth).expect(403);
      await t.http.get(`/api/v1/issues/${issue.id}/ai/summary`).set(w.viewer.auth).expect(404);
    });
  });

  // ───────────── degraded mode ─────────────

  it('keeps working without the AI service (NFR-4)', async () => {
    const w = await world();
    await ai.close();
    try {
      const res = await draft(w, w.dev).expect(503);
      expect(String(res.body)).toContain('The AI assistant is unavailable');
      // The failed call also refreshes the cached availability the web app reads.
      const status = await t.http.get('/api/v1/ai/status').set(w.dev.auth).expect(200);
      expect(status.body.available).toBe(false);
      // A summary is refused at once instead of being queued to fail later.
      const other = await issueWithThread(w);
      await t.http.post(`/api/v1/issues/${other.id}/ai/summaries`).set(w.dev.auth).expect(503);
      expect(await t.prisma.aiJob.count({ where: { projectId: w.project.id } })).toBe(0);
      // Core features are untouched.
      await t.http
        .post(`/api/v1/projects/${w.project.id}/issues`)
        .set(w.dev.auth)
        .send({ title: 'Written by hand' })
        .expect(201);
    } finally {
      await ai.listen(aiUrl);
    }
  });
});
