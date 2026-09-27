import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

describe('issues and comments (HTTP, real Postgres + Redis)', () => {
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
    labels: { bug: string; api: string };
  }

  async function world(): Promise<World> {
    const [pm, dev, viewer, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat' }),
      signIn(t, { displayName: 'Dev' }),
      signIn(t, { displayName: 'Vic' }),
      signIn(t, { displayName: 'Out' }),
    ]);
    const key = `I${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http.post('/api/v1/projects').set(pm.auth).send({ key, name: 'Issues' }).expect(201)
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
    const label = async (name: string) =>
      (
        await t.http
          .post(`/api/v1/projects/${project.id}/labels`)
          .set(pm.auth)
          .send({ name, color: '#d73a4a' })
          .expect(201)
      ).body.id as string;
    return {
      project,
      pm,
      dev,
      viewer,
      outsider,
      labels: { bug: await label('bug'), api: await label('api') },
    };
  }

  const create = (w: World, user: SignedInUser, body: Record<string, unknown>) =>
    t.http.post(`/api/v1/projects/${w.project.id}/issues`).set(user.auth).send(body);

  describe('creating', () => {
    it('numbers issues per project, records the reporter and a CREATED event', async () => {
      const w = await world();
      const first = await create(w, w.dev, { title: 'First' }).expect(201);
      const second = await create(w, w.dev, {
        title: 'Second',
        type: 'BUG',
        priority: 'HIGH',
        labelIds: [w.labels.bug],
        storyPoints: 3,
        dueDate: '2026-10-31',
      }).expect(201);

      expect(first.body).toMatchObject({
        key: `${w.project.key}-1`,
        status: 'BACKLOG',
        type: 'TASK',
        priority: 'MEDIUM',
        version: 1,
        reporter: { id: w.dev.id },
        assignee: null,
      });
      expect(second.body).toMatchObject({
        key: `${w.project.key}-2`,
        labels: [{ id: w.labels.bug, name: 'bug' }],
        storyPoints: 3,
        dueDate: '2026-10-31',
      });
      const events = await t.http
        .get(`/api/v1/issues/${first.body.id as string}/events`)
        .set(w.viewer.auth)
        .expect(200);
      expect(events.body).toEqual([
        expect.objectContaining({
          type: 'CREATED',
          actor: expect.objectContaining({ id: w.dev.id }),
        }),
      ]);
    });

    it('uses the project default assignee unless the request says otherwise', async () => {
      const w = await world();
      await t.http
        .patch(`/api/v1/projects/${w.project.id}`)
        .set(w.pm.auth)
        .send({ defaultAssigneeId: w.dev.id })
        .expect(200);

      const defaulted = await create(w, w.pm, { title: 'Defaulted' }).expect(201);
      const unassigned = await create(w, w.pm, { title: 'Nobody', assigneeId: null }).expect(201);
      expect(defaulted.body.assignee.id).toBe(w.dev.id);
      expect(unassigned.body.assignee).toBeNull();
    });

    it('rejects assignees and labels from outside the project as field errors', async () => {
      const w = await world();
      const other = await world();
      const badAssignee = await create(w, w.pm, { title: 'x', assigneeId: w.outsider.id }).expect(
        400,
      );
      expect(badAssignee.body.errors[0].path).toBe('assigneeId');
      const badLabel = await create(w, w.pm, { title: 'x', labelIds: [other.labels.bug] }).expect(
        400,
      );
      expect(badLabel.body.errors[0].path).toBe('labelIds');
    });

    it('is not allowed for viewers, and returns 404 to outsiders', async () => {
      const w = await world();
      await create(w, w.viewer, { title: 'x' }).expect(403);
      await create(w, w.outsider, { title: 'x' }).expect(404);
    });
  });

  describe('reading', () => {
    it('finds an issue by key, case-insensitively, only for members', async () => {
      const w = await world();
      await create(w, w.dev, { title: 'Keyed' }).expect(201);
      const key = `${w.project.key.toLowerCase()}-1`;

      await t.http.get(`/api/v1/issues/by-key/${key}`).set(w.viewer.auth).expect(200);
      await t.http.get(`/api/v1/issues/by-key/${key}`).set(w.outsider.auth).expect(404);
      await t.http.get(`/api/v1/issues/by-key/${w.project.key}-999`).set(w.pm.auth).expect(404);
      await t.http.get('/api/v1/issues/by-key/not-a-key').set(w.pm.auth).expect(404);
    });
  });

  describe('listing', () => {
    async function seeded() {
      const w = await world();
      const make = async (title: string, extra: Record<string, unknown> = {}) =>
        (await create(w, w.pm, { title, ...extra }).expect(201)).body as {
          id: string;
          key: string;
        };
      const login = await make('Users cannot reset their password', {
        type: 'BUG',
        priority: 'CRITICAL',
        assigneeId: w.dev.id,
        labelIds: [w.labels.bug],
      });
      const webhooks = await make('Retry payment webhooks', {
        priority: 'HIGH',
        labelIds: [w.labels.api],
      });
      const docs = await make('Document the refund API', {
        type: 'CHORE',
        priority: 'LOW',
        status: 'TODO',
      });
      return { w, login, webhooks, docs };
    }

    const keys = (res: { body: { data: { title: string }[] } }) =>
      res.body.data.map((i) => i.title);

    it('filters by status, priority, type, label and assignee', async () => {
      const { w } = await seeded();
      const url = `/api/v1/projects/${w.project.id}/issues`;
      const get = (query: string, user = w.pm) =>
        t.http.get(`${url}?${query}`).set(user.auth).expect(200);

      expect(keys(await get('status=TODO'))).toEqual(['Document the refund API']);
      expect(keys(await get('priority=CRITICAL,HIGH&sort=priority'))).toEqual([
        'Users cannot reset their password',
        'Retry payment webhooks',
      ]);
      expect(keys(await get('type=BUG'))).toEqual(['Users cannot reset their password']);
      expect(keys(await get(`label=${w.labels.api}`))).toEqual(['Retry payment webhooks']);
      expect(keys(await get('assignee=me', w.dev))).toEqual(['Users cannot reset their password']);
      expect((await get('assignee=none')).body.data).toHaveLength(2);
    });

    it('searches titles and descriptions with stemming and partial words', async () => {
      const { w } = await seeded();
      const url = `/api/v1/projects/${w.project.id}/issues`;
      const search = async (q: string) =>
        keys(
          await t.http
            .get(`${url}?q=${encodeURIComponent(q)}`)
            .set(w.pm.auth)
            .expect(200),
        );

      expect(await search('resetting passwords')).toEqual(['Users cannot reset their password']);
      expect(await search('webhook')).toEqual(['Retry payment webhooks']);
      expect(await search('refu')).toEqual(['Document the refund API']); // partial word
      expect(await search('100%_\\')).toEqual([]); // LIKE wildcards are escaped
    });

    it('pages through every issue exactly once in each sort order', async () => {
      const { w } = await seeded();
      for (let i = 0; i < 4; i++)
        await create(w, w.pm, { title: `Extra ${i}`, priority: 'MEDIUM' });
      for (const sort of ['updated', 'created', 'priority']) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const res = await t.http
            .get(
              `/api/v1/projects/${w.project.id}/issues?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
            )
            .set(w.pm.auth)
            .expect(200);
          seen.push(...res.body.data.map((i: { key: string }) => i.key));
          cursor = res.body.nextCursor as string | null;
        } while (cursor);
        expect({ sort, count: seen.length, unique: new Set(seen).size }).toEqual({
          sort,
          count: 7,
          unique: 7,
        });
      }
    });

    it('lists priority order CRITICAL → LOW', async () => {
      const { w } = await seeded();
      const res = await t.http
        .get(`/api/v1/projects/${w.project.id}/issues?sort=priority`)
        .set(w.pm.auth)
        .expect(200);
      expect(res.body.data.map((i: { priority: string }) => i.priority)).toEqual([
        'CRITICAL',
        'HIGH',
        'LOW',
      ]);
    });
  });

  describe('updating', () => {
    it('applies changes, bumps the version and records a history entry per field', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Old', labelIds: [w.labels.bug] }).expect(201))
        .body;

      const res = await t.http
        .patch(`/api/v1/issues/${issue.id as string}`)
        .set(w.dev.auth)
        .send({
          version: 1,
          title: 'New',
          priority: 'HIGH',
          assigneeId: w.dev.id,
          labelIds: [w.labels.api],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'New',
        priority: 'HIGH',
        version: 2,
        assignee: { id: w.dev.id },
        labels: [{ name: 'api' }],
      });

      const events = await t.http
        .get(`/api/v1/issues/${issue.id as string}/events`)
        .set(w.pm.auth)
        .expect(200);
      expect(
        events.body.map((e: { type: string; field: string | null; newValue: unknown }) => [
          e.type,
          e.field,
          e.newValue,
        ]),
      ).toEqual([
        ['CREATED', null, { title: 'Old', status: 'BACKLOG' }],
        ['FIELD_CHANGED', 'title', 'New'],
        ['FIELD_CHANGED', 'priority', 'HIGH'],
        ['FIELD_CHANGED', 'assignee', { id: w.dev.id, name: 'Dev' }],
        ['LABEL_ADDED', 'labels', { id: w.labels.api, name: 'api' }],
        ['LABEL_REMOVED', 'labels', null],
      ]);
    });

    it('rejects a stale version with 409 so concurrent edits never overwrite each other', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Shared' }).expect(201)).body;
      const url = `/api/v1/issues/${issue.id as string}`;

      await t.http.patch(url).set(w.pm.auth).send({ version: 1, title: 'PM edit' }).expect(200);
      const stale = await t.http
        .patch(url)
        .set(w.dev.auth)
        .send({ version: 1, title: 'Dev edit' })
        .expect(409);
      expect(stale.body.detail).toMatch(/changed by someone else/);

      const current = await t.http.get(url).set(w.pm.auth).expect(200);
      expect(current.body).toMatchObject({ title: 'PM edit', version: 2 });
    });

    it('lets exactly one of two simultaneous edits win', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Race' }).expect(201)).body;
      const url = `/api/v1/issues/${issue.id as string}`;
      const results = await Promise.all([
        t.http.patch(url).set(w.pm.auth).send({ version: 1, title: 'A' }),
        t.http.patch(url).set(w.dev.auth).send({ version: 1, title: 'B' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('does not bump the version when nothing actually changed', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Same' }).expect(201)).body;
      const res = await t.http
        .patch(`/api/v1/issues/${issue.id as string}`)
        .set(w.pm.auth)
        .send({ version: 1, title: 'Same', priority: 'MEDIUM' })
        .expect(200);
      expect(res.body.version).toBe(1);
    });

    it('enforces the workflow and keeps resolvedAt in step with the status', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Flow' }).expect(201)).body;
      const url = `/api/v1/issues/${issue.id as string}`;
      const move = (version: number, status: string) =>
        t.http.patch(url).set(w.dev.auth).send({ version, status });

      const skipped = await move(1, 'DONE').expect(400);
      expect(skipped.body.errors).toEqual([
        { path: 'status', message: "An issue can't move from Backlog to Done" },
      ]);

      await move(1, 'IN_PROGRESS').expect(200);
      const done = await move(2, 'DONE').expect(200);
      expect(done.body.resolvedAt).not.toBeNull();
      const reopened = await move(3, 'TODO').expect(200);
      expect(reopened.body.resolvedAt).toBeNull();
    });

    it('is read-only for viewers', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'x' }).expect(201)).body;
      await t.http
        .patch(`/api/v1/issues/${issue.id as string}`)
        .set(w.viewer.auth)
        .send({ version: 1, title: 'y' })
        .expect(403);
    });
  });

  describe('deleting', () => {
    it('is for project managers only, soft, and hides the issue everywhere', async () => {
      const w = await world();
      const issue = (await create(w, w.dev, { title: 'Gone' }).expect(201)).body;
      const url = `/api/v1/issues/${issue.id as string}`;

      await t.http.delete(url).set(w.dev.auth).expect(403);
      await t.http.delete(url).set(w.pm.auth).expect(204);

      await t.http.get(url).set(w.pm.auth).expect(404);
      await t.http
        .get(`/api/v1/issues/by-key/${issue.key as string}`)
        .set(w.pm.auth)
        .expect(404);
      const list = await t.http.get(`/api/v1/projects/${w.project.id}/issues`).set(w.pm.auth);
      expect(list.body.data).toEqual([]);
      // Still in the database with its history (restorable, auditable).
      await expect(
        t.prisma.issueEvent.count({ where: { issueId: issue.id as string, type: 'DELETED' } }),
      ).resolves.toBe(1);
    });
  });

  describe('comments', () => {
    it('adds comments in order and counts them on the issue', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Discuss' }).expect(201)).body;
      const url = `/api/v1/issues/${issue.id as string}/comments`;
      await t.http.post(url).set(w.dev.auth).send({ body: 'First!' }).expect(201);
      await t.http.post(url).set(w.pm.auth).send({ body: '**Second**' }).expect(201);
      await t.http.post(url).set(w.viewer.auth).send({ body: 'nope' }).expect(403);

      const list = await t.http.get(url).set(w.viewer.auth).expect(200);
      expect(list.body.map((c: { body: string }) => c.body)).toEqual(['First!', '**Second**']);
      const detail = await t.http.get(`/api/v1/issues/${issue.id as string}`).set(w.pm.auth);
      expect(detail.body.commentCount).toBe(2);
    });

    it('lets authors edit their own comments and managers moderate anyone’s', async () => {
      const w = await world();
      const issue = (await create(w, w.pm, { title: 'Moderate' }).expect(201)).body;
      const mine = (
        await t.http
          .post(`/api/v1/issues/${issue.id as string}/comments`)
          .set(w.dev.auth)
          .send({ body: 'orig' })
          .expect(201)
      ).body;
      const pmComment = (
        await t.http
          .post(`/api/v1/issues/${issue.id as string}/comments`)
          .set(w.pm.auth)
          .send({ body: 'pm' })
          .expect(201)
      ).body;

      const edited = await t.http
        .patch(`/api/v1/comments/${mine.id as string}`)
        .set(w.dev.auth)
        .send({ body: 'edited' })
        .expect(200);
      expect(edited.body).toMatchObject({ body: 'edited', editedAt: expect.any(String) });

      await t.http
        .patch(`/api/v1/comments/${pmComment.id as string}`)
        .set(w.dev.auth)
        .send({ body: 'hijack' })
        .expect(403);
      await t.http
        .delete(`/api/v1/comments/${mine.id as string}`)
        .set(w.pm.auth)
        .expect(204);

      const list = await t.http
        .get(`/api/v1/issues/${issue.id as string}/comments`)
        .set(w.pm.auth)
        .expect(200);
      expect(list.body[0]).toMatchObject({ deleted: true, body: null });
      await t.http
        .patch(`/api/v1/comments/${mine.id as string}`)
        .set(w.dev.auth)
        .send({ body: 'again' })
        .expect(404); // deleted comments are gone for editing
    });
  });
});
