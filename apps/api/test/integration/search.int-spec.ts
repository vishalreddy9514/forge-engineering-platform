import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomInt } from 'node:crypto';
import type request from 'supertest';

import { AiUsageService } from '../../src/ai/ai-usage.service';
import { AiClient } from '../../src/ai/ai.client';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { OutboxRelay } from '../../src/outbox/outbox.relay';
import { INDEXING_JOBS, IndexingJobs } from '../../src/search/indexing.jobs';
import { IndexingService } from '../../src/search/indexing.service';
import { FakeAiService } from './ai/fake-ai-service';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

describe('search, related issues, assistant chat and indexing (fake AI service, real Postgres + Redis)', () => {
  let t: TestApp;
  let ai: FakeAiService;
  let aiUrl: string;
  let indexingQueue: Queue;
  let indexing: IndexingService;
  let relay: OutboxRelay;
  let notificationsQueue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    const config = t.app.get(ConfigService);
    aiUrl = config.getOrThrow<string>('AI_SERVICE_URL');
    ai = new FakeAiService(config.getOrThrow<string>('AI_SERVICE_TOKEN'));
    await ai.listen(aiUrl);
    // The real AI service marks a document indexed in the transaction that writes its chunks.
    ai.onIndex = async (documentId) => {
      await t.prisma.document.updateMany({
        where: { id: documentId },
        data: { indexedAt: new Date() },
      });
    };
    indexingQueue = t.app.get<Queue>(getQueueToken(QUEUES.INDEXING));
    const jobs = t.app.get(IndexingJobs);
    // The worker's service, wired by hand: the API process does not run indexing jobs.
    indexing = new IndexingService(t.prisma, t.app.get(AiClient), t.app.get(AiUsageService), jobs);
    // Notifications are relayed too but not consumed here; a plain queue stands in for them.
    notificationsQueue = new Queue(QUEUES.NOTIFICATIONS, {
      prefix: 'forge',
      connection: { url: config.getOrThrow<string>('REDIS_URL') },
    });
    relay = new OutboxRelay(t.prisma, config, notificationsQueue, indexingQueue);
  });

  afterAll(async () => {
    await notificationsQueue.close();
    await ai.close();
    await t.close();
  });

  beforeEach(async () => {
    ai.mode = 'ok';
    ai.requests.length = 0;
    ai.resetRetrieval();
    await indexingQueue.obliterate({ force: true });
    await t.redis.flushdb();
  });

  interface World {
    project: { id: string; key: string };
    pm: SignedInUser;
    dev: SignedInUser;
    viewer: SignedInUser;
    /** Someone else's project, which nobody above can read. */
    other: { id: string; key: string };
  }

  async function createProject(owner: SignedInUser, name: string) {
    const key = `S${uid().toUpperCase()}`.slice(0, 8);
    return (await t.http.post('/api/v1/projects').set(owner.auth).send({ key, name }).expect(201))
      .body as { id: string; key: string };
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat Manager' }),
      signIn(t, { displayName: 'Dee Developer' }),
      signIn(t, { displayName: 'Vic Viewer' }),
      signIn(t, { displayName: 'Oz Outsider' }),
    ]);
    const project = await createProject(pm, 'Search project');
    const other = await createProject(outsider, 'Private project');
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
    return { project, pm, dev, viewer, other };
  }

  async function createIssue(w: World, fields: Record<string, unknown> = {}) {
    return (
      await t.http
        .post(`/api/v1/projects/${w.project.id}/issues`)
        .set(w.pm.auth)
        .send({ title: 'Webhook retries double-charge', type: 'BUG', priority: 'HIGH', ...fields })
        .expect(201)
    ).body as { id: string; key: string; number: number; version: number };
  }

  const documentsOf = (
    sourceType: 'ISSUE' | 'COMMENT' | 'PULL_REQUEST' | 'COMMIT',
    ids: string[],
  ) =>
    t.prisma.document.findMany({
      where: { sourceType, sourceId: { in: ids } },
      orderBy: { projectId: 'asc' },
    });
  const indexCalls = () => ai.requests.filter((r) => r.path === '/v1/index');

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

  const ask = (as: SignedInUser, body: Record<string, unknown>) =>
    t.http
      .post('/api/v1/ai/chat')
      .set(as.auth)
      .send(body)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          done(null, text);
        });
      });

  describe('indexing', () => {
    it('writes a normalised document for an issue, embeds it once and records the cost', async () => {
      const w = await world();
      const issue = await createIssue(w, { description: 'Two ledger rows for one event.' });

      await expect(indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id })).resolves.toBe(
        'indexed',
      );

      const [doc] = await documentsOf('ISSUE', [issue.id]);
      expect(doc).toMatchObject({
        projectId: w.project.id,
        title: `${issue.key}: Webhook retries double-charge`,
        url: `/projects/${w.project.key}/issues/${issue.key}`,
        content:
          `Issue ${issue.key}: Webhook retries double-charge\n` +
          'Type: Bug · Priority: High · Status: Backlog · Assignee: unassigned\n\n' +
          'Two ledger rows for one event.',
      });
      expect(indexCalls().map((r) => r.body)).toEqual([{ documentId: doc?.id }]);
      const usage = await t.prisma.aiUsage.findMany({ where: { projectId: w.project.id } });
      expect(usage).toEqual([
        expect.objectContaining({ feature: 'EMBEDDING', userId: null, model: 'fake-embedding-1' }),
      ]);

      // Unchanged source: no embedding call at all.
      await expect(indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id })).resolves.toBe(
        'unchanged',
      );
      expect(indexCalls()).toHaveLength(1);
    });

    it('queues one index job per source through the outbox, however many edits', async () => {
      const w = await world();
      const issue = await createIssue(w);
      let version = issue.version;
      for (const title of ['Second title', 'Third title']) {
        const res = await t.http
          .patch(`/api/v1/issues/${issue.id}`)
          .set(w.pm.auth)
          .send({ version, title })
          .expect(200);
        version = (res.body as { version: number }).version;
      }
      const comment = (
        await t.http
          .post(`/api/v1/issues/${issue.id}/comments`)
          .set(w.dev.auth)
          .send({ body: 'Reproduced.' })
          .expect(201)
      ).body as { id: string };

      const rows = await t.prisma.outboxEvent.findMany({
        where: { eventType: 'search.index', aggregateId: issue.id },
        orderBy: { id: 'asc' },
      });
      // Each event carries the ID of the request that caused it (architecture §11).
      expect(rows.map((r) => r.payload)).toEqual([
        { sourceType: 'ISSUE', sourceId: issue.id, requestId: expect.any(String) },
        { sourceType: 'ISSUE', sourceId: issue.id, requestId: expect.any(String) },
        { sourceType: 'ISSUE', sourceId: issue.id, requestId: expect.any(String) },
        { sourceType: 'COMMENT', sourceId: comment.id, requestId: expect.any(String) },
      ]);

      // Other test files run their own relays over the same outbox table in parallel and may
      // claim these rows first, so publish exactly ours through the relay's routing.
      await relay.publish(
        rows.map((r) => ({
          id: r.id,
          event_type: r.eventType,
          payload: r.payload as Record<string, unknown>,
        })),
      );
      const waiting = await indexingQueue.getJobs();
      const ours = waiting.filter((job) =>
        [issue.id, comment.id].includes((job.data as { sourceId: string }).sourceId),
      );
      expect(
        ours.map((job) => [job.name, (job.data as { sourceType: string }).sourceType]).sort(),
      ).toEqual([
        [INDEXING_JOBS.OUTBOX, 'COMMENT'],
        [INDEXING_JOBS.OUTBOX, 'ISSUE'],
      ]);
    });

    it('re-indexes comments after a rename, and removes the issue and its comments on delete', async () => {
      const w = await world();
      const issue = await createIssue(w);
      const comment = (
        await t.http
          .post(`/api/v1/issues/${issue.id}/comments`)
          .set(w.dev.auth)
          .send({ body: 'Fixed with a unique constraint.' })
          .expect(201)
      ).body as { id: string };
      await indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id });
      await indexing.indexSource({ sourceType: 'COMMENT', sourceId: comment.id });
      const [commentDoc] = await documentsOf('COMMENT', [comment.id]);
      expect(commentDoc?.content).toBe(
        `Comment on ${issue.key} (Webhook retries double-charge) by Dee Developer:\n\n` +
          'Fixed with a unique constraint.',
      );
      expect(commentDoc?.url).toBe(
        `/projects/${w.project.key}/issues/${issue.key}#comment-${comment.id}`,
      );

      await t.http
        .patch(`/api/v1/issues/${issue.id}`)
        .set(w.pm.auth)
        .send({ version: issue.version, title: 'Duplicate receipts' })
        .expect(200);
      await indexingQueue.obliterate({ force: true });
      await indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id });
      const queued = await indexingQueue.getJobs(['waiting']);
      expect(queued.map((job) => job.data as unknown)).toEqual([
        { sourceType: 'COMMENT', sourceId: comment.id },
      ]);

      await t.http.delete(`/api/v1/issues/${issue.id}`).set(w.pm.auth).expect(204);
      await indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id });
      expect(await documentsOf('ISSUE', [issue.id])).toEqual([]);
      expect(await documentsOf('COMMENT', [comment.id])).toEqual([]);
    });

    it('keeps the text when the AI service is down, and the backfill retries it', async () => {
      const w = await world();
      const issue = await createIssue(w);
      ai.mode = 'error_503';

      await expect(
        indexing.indexSource({ sourceType: 'ISSUE', sourceId: issue.id }),
      ).rejects.toMatchObject({ retryable: true });
      const [doc] = await documentsOf('ISSUE', [issue.id]);
      expect(doc?.indexedAt).toBeNull();

      await indexingQueue.obliterate({ force: true });
      await indexing.backfill();
      const queued = await indexingQueue.getJobs(['waiting']);
      expect(queued.map((job) => job.data as unknown)).toContainEqual({
        sourceType: 'ISSUE',
        sourceId: issue.id,
        force: false,
      });
    });

    it('indexes pull requests and commits once per linked project, and follows unlinking', async () => {
      const w = await world();
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
          fullName: 'acme/payments',
          defaultBranch: 'main',
          isPrivate: true,
          htmlUrl: 'https://github.com/acme/payments',
          projects: { create: [{ projectId: w.project.id }, { projectId: w.other.id }] },
        },
      });
      const pr = await t.prisma.githubPullRequest.create({
        data: {
          repositoryId: repo.id,
          githubId: randomInt(1, 2 ** 31),
          number: 41,
          title: 'Dedupe Stripe webhook deliveries',
          body: 'Stores event IDs.',
          state: 'MERGED',
          headRef: 'fix/dedupe',
          headSha: 'a'.repeat(40),
          baseRef: 'main',
          htmlUrl: 'https://github.com/acme/payments/pull/41',
          openedAt: new Date(),
          githubUpdatedAt: new Date(),
        },
      });
      const commit = await t.prisma.githubCommit.create({
        data: {
          repositoryId: repo.id,
          sha: 'b'.repeat(40),
          message: 'Add processed_stripe_events table\n\nUnique on event ID.',
          authorName: 'Sam Okafor',
          committedAt: new Date(),
          htmlUrl: 'https://github.com/acme/payments/commit/bbbbbbb',
        },
      });

      await indexing.indexRepository(repo.id);
      const prDocs = await documentsOf('PULL_REQUEST', [pr.id]);
      const commitDocs = await documentsOf('COMMIT', [commit.id]);
      expect(new Set(prDocs.map((d) => d.projectId))).toEqual(new Set([w.project.id, w.other.id]));
      expect(commitDocs).toHaveLength(2);
      expect(prDocs[0]?.content).toBe(
        'Pull request #41 in acme/payments: Dedupe Stripe webhook deliveries\n' +
          'State: merged · Author: unknown · Branch: fix/dedupe → main\n\nStores event IDs.',
      );
      expect(commitDocs[0]?.title).toBe('Commit bbbbbbb: Add processed_stripe_events table');

      await t.prisma.projectRepository.delete({
        where: { projectId_repositoryId: { projectId: w.other.id, repositoryId: repo.id } },
      });
      ai.requests.length = 0;
      await indexing.indexRepository(repo.id);
      expect((await documentsOf('PULL_REQUEST', [pr.id])).map((d) => d.projectId)).toEqual([
        w.project.id,
      ]);
      expect(await documentsOf('COMMIT', [commit.id])).toHaveLength(1);
      expect(indexCalls()).toHaveLength(0); // the remaining copies were unchanged

      // A repository removed from the installation: its rows cascade, the backfill tidies up.
      await t.prisma.githubRepository.delete({ where: { id: repo.id } });
      await indexing.backfill();
      expect(await documentsOf('PULL_REQUEST', [pr.id])).toEqual([]);
      expect(await documentsOf('COMMIT', [commit.id])).toEqual([]);
    });
  });

  describe('semantic search', () => {
    const result = (projectId: string, title: string) => ({
      documentId: crypto.randomUUID(),
      projectId,
      sourceType: 'ISSUE',
      sourceId: crypto.randomUUID(),
      title,
      url: '/x',
      headingPath: null,
      snippet: 'snippet',
      score: 0.03,
      vectorRank: 1,
      keywordRank: null,
    });

    it('asks only about projects the caller can read, and drops anything else it gets back', async () => {
      const w = await world();
      ai.searchResults = [result(w.project.id, 'Visible'), result(w.other.id, 'Private')];

      const res = await t.http
        .get('/api/v1/search/semantic')
        .query({ q: 'webhook retries' })
        .set(w.viewer.auth)
        .expect(200);

      expect((res.body as { data: { title: string; projectKey: string }[] }).data).toEqual([
        expect.objectContaining({ title: 'Visible', projectKey: w.project.key }),
      ]);
      const sent = ai.requests.find((r) => r.path === '/v1/search');
      expect(sent?.body).toMatchObject({ query: 'webhook retries', projectIds: [w.project.id] });
      const usage = await t.prisma.aiUsage.findMany({ where: { userId: w.viewer.id } });
      expect(usage.map((u) => u.feature)).toEqual(['SEMANTIC_SEARCH']);
    });

    it("narrows to one project, and treats a project the caller can't read as not found", async () => {
      const w = await world();
      await t.http
        .get('/api/v1/search/semantic')
        .query({ q: 'webhook', projectId: w.project.id, type: 'UPLOAD' })
        .set(w.dev.auth)
        .expect(200);
      expect(ai.requests.find((r) => r.path === '/v1/search')?.body).toMatchObject({
        projectIds: [w.project.id],
        sourceTypes: ['UPLOAD'],
      });
      await t.http
        .get('/api/v1/search/semantic')
        .query({ q: 'webhook', projectId: w.other.id })
        .set(w.dev.auth)
        .expect(404);
      await t.http.get('/api/v1/search/semantic').query({ q: 'w' }).set(w.dev.auth).expect(400);
    });

    it('answers 503 when the AI service is unreachable', async () => {
      const w = await world();
      await ai.close();
      try {
        await t.http
          .get('/api/v1/search/semantic')
          .query({ q: 'webhook' })
          .set(w.dev.auth)
          .expect(503);
      } finally {
        await ai.listen(aiUrl);
      }
    });
  });

  describe('related issues', () => {
    it('lists similar issues in AI-service order, without the issue itself or deleted ones', async () => {
      const w = await world();
      const [a, b, c] = [await createIssue(w), await createIssue(w), await createIssue(w)];
      await t.http.delete(`/api/v1/issues/${c.id}`).set(w.pm.auth).expect(204);
      const related = (issue: { id: string }, score: number) => ({
        issueId: issue.id,
        documentId: crypto.randomUUID(),
        title: 't',
        url: '/x',
        score,
      });
      ai.relatedResults = [related(c, 0.9), related(b, 0.8), related(a, 0.7)];

      const res = await t.http.get(`/api/v1/issues/${a.id}/related`).set(w.dev.auth).expect(200);

      expect((res.body as { data: unknown[] }).data).toEqual([
        {
          id: b.id,
          key: b.key,
          title: 'Webhook retries double-charge',
          status: 'BACKLOG',
          type: 'BUG',
          score: 0.8,
        },
      ]);
      expect(ai.requests.find((r) => r.path === '/v1/related')?.body).toMatchObject({
        projectId: w.project.id,
        issueId: a.id,
      });
    });

    it('finds possible duplicates of draft text; viewers cannot', async () => {
      const w = await world();
      const issue = await createIssue(w);
      ai.relatedResults = [
        { issueId: issue.id, documentId: crypto.randomUUID(), title: 't', url: '/x', score: 0.6 },
      ];
      const path = `/api/v1/projects/${w.project.id}/ai/related`;
      const text = 'Stripe retries charge customers twice';

      await t.http.post(path).set(w.viewer.auth).send({ text }).expect(403);
      const res = await t.http.post(path).set(w.dev.auth).send({ text }).expect(200);

      expect((res.body as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([issue.id]);
      const usage = await t.prisma.aiUsage.findMany({ where: { userId: w.dev.id } });
      expect(usage).toEqual([
        expect.objectContaining({ feature: 'RELATED_ISSUES', inputTokens: 7 }),
      ]);
    });
  });

  describe('assistant chat', () => {
    const citation = (n: number, projectId: string, title: string) => ({
      n,
      sourceType: 'ISSUE',
      sourceId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      projectId,
      title,
      url: `/x/${String(n)}`,
      headingPath: null,
    });

    it('streams an answer with citations from readable projects only, and keeps the conversation', async () => {
      const w = await world();
      ai.chatCitations = [citation(1, w.project.id, 'Visible'), citation(2, w.other.id, 'Private')];

      const res = await ask(w.dev, { message: 'Why were customers charged twice?' }).expect(200);

      const streamed = events(res);
      expect(streamed.map(([kind]) => kind)).toEqual(['conversation', 'delta', 'result']);
      const result = streamed[2]?.[1] as { conversationId: string; citations: unknown[] };
      expect(result.citations).toEqual([
        {
          n: 1,
          sourceType: 'ISSUE',
          title: 'Visible',
          url: '/x/1',
          projectKey: w.project.key,
          headingPath: null,
        },
      ]);
      expect(ai.requests.find((r) => r.path === '/v1/chat')?.body).toEqual({
        messages: [{ role: 'user', content: 'Why were customers charged twice?' }],
        projects: [{ id: w.project.id, key: w.project.key, name: 'Search project' }],
      });

      const detail = await t.http
        .get(`/api/v1/ai/conversations/${result.conversationId}`)
        .set(w.dev.auth)
        .expect(200);
      expect(detail.body).toMatchObject({
        title: 'Why were customers charged twice?',
        messages: [
          { role: 'USER', content: 'Why were customers charged twice?', citations: [] },
          { role: 'ASSISTANT', citations: [expect.objectContaining({ title: 'Visible' })] },
        ],
      });
      const usage = await t.prisma.aiUsage.findMany({ where: { userId: w.dev.id } });
      expect(usage.map((u) => [u.feature, u.model]).sort()).toEqual([
        ['CHAT', 'fake'],
        ['CHAT', 'fake-embedding-1'],
      ]);
    });

    it('continues a conversation with its history; nobody else can read or continue it', async () => {
      const w = await world();
      const first = events(await ask(w.dev, { message: 'First question' }).expect(200));
      const conversationId = (first[0]?.[1] as { conversationId: string }).conversationId;
      ai.requests.length = 0;

      await ask(w.dev, { conversationId, message: 'And then?' }).expect(200);
      expect(ai.requests.find((r) => r.path === '/v1/chat')?.body.messages).toEqual([
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'It was fixed by deduplicating webhook events [1].' },
        { role: 'user', content: 'And then?' },
      ]);

      await ask(w.viewer, { conversationId, message: 'Mine now?' }).expect(404);
      await t.http.get(`/api/v1/ai/conversations/${conversationId}`).set(w.viewer.auth).expect(404);
      const mine = await t.http.get('/api/v1/ai/conversations').set(w.dev.auth).expect(200);
      expect((mine.body as { id: string }[]).map((c) => c.id)).toEqual([conversationId]);
      await t.http
        .delete(`/api/v1/ai/conversations/${conversationId}`)
        .set(w.viewer.auth)
        .expect(404);
      await t.http.delete(`/api/v1/ai/conversations/${conversationId}`).set(w.dev.auth).expect(204);
    });

    it("runs query_issues itself, within the caller's projects only", async () => {
      const w = await world();
      const fixed = await createIssue(w, { title: 'Refund 500s' });
      await createIssue(w, { title: 'Still open' });
      await t.prisma.issue.update({
        where: { id: fixed.id },
        data: { status: 'DONE', resolvedAt: new Date() },
      });
      const args = {
        project_key: w.project.key,
        type: 'BUG',
        status: 'done',
        priority: null,
        sprint: null,
        updated_within_days: null,
      };
      ai.chatToolArguments = args;

      const streamed = events(await ask(w.dev, { message: 'Which bugs are fixed?' }).expect(200));

      expect(streamed.map(([kind]) => kind)).toEqual(['conversation', 'tool', 'delta', 'result']);
      expect(streamed[1]?.[1]).toEqual({
        name: 'query_issues',
        description: `Looking up done bugs in ${w.project.key}`,
      });
      const second = ai.requests.filter((r) => r.path === '/v1/chat')[1]?.body as {
        toolResult: { total: number; issues: { key: string; status: string }[] };
        toolCall: { name: string };
      };
      expect(second.toolCall.name).toBe('query_issues');
      expect(second.toolResult.total).toBe(1);
      expect(second.toolResult.issues.map((i) => [i.key, i.status])).toEqual([[fixed.key, 'DONE']]);

      // The step is kept with the conversation, between the question and the answer.
      const conversationId = (streamed[0]?.[1] as { conversationId: string }).conversationId;
      const detail = await t.http
        .get(`/api/v1/ai/conversations/${conversationId}`)
        .set(w.dev.auth)
        .expect(200);
      expect(
        (detail.body as { messages: { role: string; content: string }[] }).messages.map((m) => [
          m.role,
          m.role === 'TOOL' ? m.content : '',
        ]),
      ).toEqual([
        ['USER', ''],
        ['TOOL', `Looking up done bugs in ${w.project.key}`],
        ['ASSISTANT', ''],
      ]);

      // Another project's key, or arguments that fail validation, find nothing.
      for (const attempt of [
        { ...args, project_key: w.other.key },
        { ...args, status: 'everything' },
      ]) {
        ai.requests.length = 0;
        ai.chatToolArguments = attempt;
        await ask(w.dev, { message: 'Which bugs are fixed?' }).expect(200);
        const body = ai.requests.filter((r) => r.path === '/v1/chat')[1]?.body as {
          toolResult: { total: number; issues: unknown[] };
        };
        expect(body.toolResult).toEqual({ total: 0, issues: [] });
      }
    });

    it('reports a provider failure as a stream error without internals', async () => {
      const w = await world();
      ai.mode = 'provider_unavailable';
      const streamed = events(await ask(w.dev, { message: 'Hello?' }).expect(200));
      expect(streamed.at(-1)).toEqual([
        'error',
        {
          code: 'provider_unavailable',
          message: 'The AI provider is busy or unreachable. Please try again in a minute.',
        },
      ]);
    });

    it('cannot be scoped to a project the caller cannot read', async () => {
      const w = await world();
      await ask(w.dev, { message: 'Hi', projectId: w.other.id }).expect(404);
      expect(ai.requests.filter((r) => r.path === '/v1/chat')).toHaveLength(0);
    });
  });

  describe('uploaded documents', () => {
    it('developers upload and edit, members read, viewers cannot write', async () => {
      const w = await world();
      const base = `/api/v1/projects/${w.project.id}/documents`;
      // Larger than the API's default 100 kB JSON limit, which this route raises.
      const content = `# Runbook\n\n${'Restart the reconciliation job. '.repeat(8000)}`;

      await t.http.post(base).set(w.viewer.auth).send({ title: 'Runbook', content }).expect(403);
      const created = (
        await t.http.post(base).set(w.dev.auth).send({ title: 'Runbook', content }).expect(201)
      ).body as {
        id: string;
        sizeBytes: number;
        indexedAt: string | null;
        createdBy: { id: string };
      };
      expect(created).toMatchObject({
        sizeBytes: content.length,
        indexedAt: null,
        createdBy: { id: w.dev.id },
      });

      const outbox = await t.prisma.outboxEvent.findMany({ where: { aggregateId: created.id } });
      expect(outbox.map((r) => r.payload)).toEqual([
        { sourceType: 'UPLOAD', sourceId: created.id, requestId: expect.any(String) },
      ]);
      await expect(
        indexing.indexSource({ sourceType: 'UPLOAD', sourceId: created.id }),
      ).resolves.toBe('indexed');

      const list = await t.http.get(base).set(w.viewer.auth).expect(200);
      expect((list.body as { id: string }[]).map((d) => d.id)).toEqual([created.id]);
      const detail = await t.http.get(`${base}/${created.id}`).set(w.viewer.auth).expect(200);
      expect((detail.body as { content: string }).content).toBe(content);
      const row = await t.prisma.document.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.url).toBe(`/projects/${w.project.key}/documents/${created.id}`);

      const updated = await t.http
        .put(`${base}/${created.id}`)
        .set(w.dev.auth)
        .send({ title: 'Runbook v2', content: '# Runbook\n\nShorter.' })
        .expect(200);
      expect(updated.body).toMatchObject({ title: 'Runbook v2', indexedAt: null });

      await t.http.delete(`${base}/${created.id}`).set(w.viewer.auth).expect(403);
      await t.http.delete(`${base}/${created.id}`).set(w.dev.auth).expect(204);
      await t.http.get(`${base}/${created.id}`).set(w.dev.auth).expect(404);
    });

    it('rejects documents over 1 MB, and documents of other projects are not found', async () => {
      const w = await world();
      await t.http
        .post(`/api/v1/projects/${w.project.id}/documents`)
        .set(w.dev.auth)
        .send({ title: 'Huge', content: 'x'.repeat(1024 * 1024 + 1) })
        .expect(400);
      await t.http.get(`/api/v1/projects/${w.other.id}/documents`).set(w.dev.auth).expect(404);
    });
  });

  it('only administrators can rebuild the index', async () => {
    const w = await world();
    const admin = await signIn(t, { isAdmin: true });
    await t.http.post('/api/v1/admin/search/reindex').set(w.pm.auth).expect(403);
    const res = await t.http.post('/api/v1/admin/search/reindex').set(admin.auth).expect(202);
    const jobs = await indexingQueue.getJobs(['waiting']);
    expect(jobs.map((job) => [job.name, job.data as unknown])).toEqual([
      [INDEXING_JOBS.BACKFILL, { all: true, requestId: res.headers['x-request-id'] }],
    ]);
  });
});
