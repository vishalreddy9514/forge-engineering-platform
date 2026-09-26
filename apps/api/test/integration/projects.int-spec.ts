import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

describe('projects, members and labels (HTTP, real Postgres + Redis)', () => {
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

  const key = () => `P${uid().toUpperCase()}`.slice(0, 8);

  async function createProject(owner: SignedInUser, overrides: Record<string, unknown> = {}) {
    const res = await t.http
      .post('/api/v1/projects')
      .set(owner.auth)
      .send({ key: key(), name: 'Payments', description: 'Money', ...overrides })
      .expect(201);
    return res.body as { id: string; key: string };
  }

  async function addMember(
    project: { id: string },
    pm: SignedInUser,
    user: SignedInUser,
    role: string,
  ) {
    await t.http
      .post(`/api/v1/projects/${project.id}/members`)
      .set(pm.auth)
      .send({ email: user.email, role })
      .expect(201);
  }

  describe('creating and reading', () => {
    it('makes the creator the first project manager and returns the detail view', async () => {
      const owner = await signIn(t, { displayName: 'Owner' });
      const k = key();
      const res = await t.http
        .post('/api/v1/projects')
        .set(owner.auth)
        .send({ key: ` ${k.toLowerCase()} `, name: '  Payments  ' })
        .expect(201);

      expect(res.body).toMatchObject({
        key: k,
        name: 'Payments',
        myRole: 'PROJECT_MANAGER',
        memberCount: 1,
        openIssueCount: 0,
        archivedAt: null,
        activeSprint: null,
        createdBy: { id: owner.id, displayName: 'Owner' },
      });
      await expect(
        t.prisma.auditLog.count({ where: { action: 'project.created', entityId: res.body.id } }),
      ).resolves.toBe(1);
    });

    it('rejects a key that is taken (case-insensitively) as a field error', async () => {
      const owner = await signIn(t);
      const project = await createProject(owner);
      const res = await t.http
        .post('/api/v1/projects')
        .set(owner.auth)
        .send({ key: project.key.toLowerCase(), name: 'Dup' })
        .expect(409);
      expect(res.body.errors).toEqual([
        { path: 'key', message: `The key ${project.key} is already taken` },
      ]);
    });

    it('lists only the caller’s projects, alphabetically, with keyset pagination', async () => {
      const me = await signIn(t);
      const stranger = await signIn(t);
      const tag = uid();
      for (const name of [`${tag} Charlie`, `${tag} Alpha`, `${tag} Bravo`]) {
        await createProject(me, { name });
      }
      await createProject(stranger, { name: `${tag} Hidden` });

      const first = await t.http.get(`/api/v1/projects?q=${tag}&limit=2`).set(me.auth).expect(200);
      expect(first.body.data.map((p: { name: string }) => p.name)).toEqual([
        `${tag} Alpha`,
        `${tag} Bravo`,
      ]);
      const second = await t.http
        .get(`/api/v1/projects?q=${tag}&limit=2&cursor=${first.body.nextCursor as string}`)
        .set(me.auth)
        .expect(200);
      expect(second.body.data.map((p: { name: string }) => p.name)).toEqual([`${tag} Charlie`]);
      expect(second.body.nextCursor).toBeNull();
    });

    it('shows platform admins every project, marked with the ADMIN role', async () => {
      const owner = await signIn(t);
      const admin = await signIn(t, { isAdmin: true });
      const tag = uid();
      await createProject(owner, { name: `${tag} Owned elsewhere` });
      const res = await t.http.get(`/api/v1/projects?q=${tag}`).set(admin.auth).expect(200);
      expect(res.body.data).toEqual([expect.objectContaining({ myRole: 'ADMIN' })]);
    });

    it('resolves a project by key for members and 404s for everyone else', async () => {
      const owner = await signIn(t);
      const outsider = await signIn(t);
      const project = await createProject(owner);

      await t.http
        .get(`/api/v1/projects/by-key/${project.key.toLowerCase()}`)
        .set(owner.auth)
        .expect(200);
      await t.http.get(`/api/v1/projects/by-key/${project.key}`).set(outsider.auth).expect(404);
      await t.http.get(`/api/v1/projects/${project.id}`).set(outsider.auth).expect(404);
    });
  });

  describe('updating', () => {
    it('lets managers edit details but not developers or viewers', async () => {
      const pm = await signIn(t);
      const dev = await signIn(t);
      const viewer = await signIn(t);
      const project = await createProject(pm);
      await addMember(project, pm, dev, 'DEVELOPER');
      await addMember(project, pm, viewer, 'VIEWER');

      await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ name: 'Renamed', description: null })
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ name: 'Renamed', description: null });
        });
      for (const user of [dev, viewer]) {
        await t.http
          .patch(`/api/v1/projects/${project.id}`)
          .set(user.auth)
          .send({ name: 'Nope' })
          .expect(403);
      }
    });

    it('only accepts a project member as the default assignee', async () => {
      const pm = await signIn(t);
      const dev = await signIn(t);
      const outsider = await signIn(t);
      const project = await createProject(pm);
      await addMember(project, pm, dev, 'DEVELOPER');

      const res = await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ defaultAssigneeId: outsider.id })
        .expect(400);
      expect(res.body.errors[0].path).toBe('defaultAssigneeId');

      const ok = await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ defaultAssigneeId: dev.id })
        .expect(200);
      expect(ok.body.defaultAssignee.id).toBe(dev.id);
    });

    it('audits only the fields that actually changed', async () => {
      const pm = await signIn(t);
      const project = await createProject(pm, { name: 'Same', description: 'Same' });
      await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ name: 'Different', description: 'Same', defaultAssigneeId: null })
        .expect(200);
      await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ name: 'Different' })
        .expect(200); // no-op: nothing to record

      const entries = await t.prisma.auditLog.findMany({
        where: { action: 'project.updated', entityId: project.id },
      });
      expect(entries.map((e) => e.metadata)).toEqual([{ fields: ['name'] }]);
    });

    it('never changes the key (issue keys depend on it)', async () => {
      const pm = await signIn(t);
      const project = await createProject(pm);
      const res = await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ key: 'HIJACK', name: 'Still here' })
        .expect(200);
      expect(res.body.key).toBe(project.key);
    });
  });

  describe('archiving and deleting', () => {
    it('makes an archived project read-only until it is restored', async () => {
      const pm = await signIn(t);
      const project = await createProject(pm);

      await t.http.post(`/api/v1/projects/${project.id}/archive`).set(pm.auth).expect(200);
      await t.http.get(`/api/v1/projects/${project.id}`).set(pm.auth).expect(200);
      await t.http
        .post(`/api/v1/projects/${project.id}/labels`)
        .set(pm.auth)
        .send({ name: 'bug', color: '#d73a4a' })
        .expect(409);
      await t.http
        .patch(`/api/v1/projects/${project.id}`)
        .set(pm.auth)
        .send({ name: 'x' })
        .expect(409);

      // Archived projects move out of the default list and into ?archived=true.
      const active = await t.http.get('/api/v1/projects').set(pm.auth).expect(200);
      expect(active.body.data.map((p: { id: string }) => p.id)).not.toContain(project.id);
      const archived = await t.http.get('/api/v1/projects?archived=true').set(pm.auth).expect(200);
      expect(archived.body.data.map((p: { id: string }) => p.id)).toContain(project.id);

      await t.http.post(`/api/v1/projects/${project.id}/restore`).set(pm.auth).expect(200);
      await t.http
        .post(`/api/v1/projects/${project.id}/labels`)
        .set(pm.auth)
        .send({ name: 'bug', color: '#d73a4a' })
        .expect(201);

      const actions = await t.prisma.auditLog.findMany({
        where: { entityId: project.id, action: { in: ['project.archived', 'project.restored'] } },
        orderBy: { id: 'asc' },
        select: { action: true },
      });
      expect(actions.map((a) => a.action)).toEqual(['project.archived', 'project.restored']);
    });

    it('permanently deletes only for admins, only when archived, only with the key confirmed', async () => {
      const pm = await signIn(t);
      const admin = await signIn(t, { isAdmin: true });
      const project = await createProject(pm);
      const url = `/api/v1/projects/${project.id}`;

      await t.http.delete(`${url}?confirm=${project.key}`).set(pm.auth).expect(403);
      await t.http.delete(`${url}?confirm=${project.key}`).set(admin.auth).expect(409);
      await t.http.post(`${url}/archive`).set(pm.auth).expect(200);
      await t.http.delete(`${url}?confirm=WRONG`).set(admin.auth).expect(400);
      await t.http.delete(`${url}?confirm=${project.key}`).set(admin.auth).expect(204);

      await t.http.get(url).set(pm.auth).expect(404);
      await expect(
        t.prisma.auditLog.findFirst({ where: { action: 'project.deleted', entityId: project.id } }),
      ).resolves.toMatchObject({
        actorId: admin.id,
        metadata: { key: project.key, name: 'Payments' },
      });
    });
  });

  describe('members', () => {
    it('adds people by email, lists them by role, and grants access immediately', async () => {
      const pm = await signIn(t, { displayName: 'Pat' });
      const dev = await signIn(t, { displayName: 'Dev' });
      const project = await createProject(pm);
      // Prime the membership cache with "not a member".
      await t.http.get(`/api/v1/projects/${project.id}`).set(dev.auth).expect(404);

      await addMember(project, pm, dev, 'DEVELOPER');
      await t.http.get(`/api/v1/projects/${project.id}`).set(dev.auth).expect(200);

      const list = await t.http
        .get(`/api/v1/projects/${project.id}/members`)
        .set(dev.auth)
        .expect(200);
      expect(
        list.body.map((m: { user: { displayName: string }; role: string }) => [
          m.user.displayName,
          m.role,
        ]),
      ).toEqual([
        ['Pat', 'PROJECT_MANAGER'],
        ['Dev', 'DEVELOPER'],
      ]);
    });

    it('explains unknown emails and duplicates as field errors', async () => {
      const pm = await signIn(t);
      const project = await createProject(pm);
      const unknown = await t.http
        .post(`/api/v1/projects/${project.id}/members`)
        .set(pm.auth)
        .send({ email: `nobody-${uid()}@example.test`, role: 'VIEWER' })
        .expect(404);
      expect(unknown.body.errors[0].path).toBe('email');

      const dup = await t.http
        .post(`/api/v1/projects/${project.id}/members`)
        .set(pm.auth)
        .send({ email: pm.email, role: 'VIEWER' })
        .expect(409);
      expect(dup.body.errors[0].message).toBe('This person is already a member');
    });

    it('applies role changes and removals on the very next request', async () => {
      const pm = await signIn(t);
      const dev = await signIn(t);
      const project = await createProject(pm);
      await addMember(project, pm, dev, 'VIEWER');
      const labelUrl = `/api/v1/projects/${project.id}/labels`;
      await t.http.post(labelUrl).set(dev.auth).send({ name: 'a', color: '#000000' }).expect(403);

      await t.http
        .patch(`/api/v1/projects/${project.id}/members/${dev.id}`)
        .set(pm.auth)
        .send({ role: 'PROJECT_MANAGER' })
        .expect(200);
      await t.http.post(labelUrl).set(dev.auth).send({ name: 'a', color: '#000000' }).expect(201);

      await t.http
        .delete(`/api/v1/projects/${project.id}/members/${dev.id}`)
        .set(pm.auth)
        .expect(204);
      await t.http.get(`/api/v1/projects/${project.id}`).set(dev.auth).expect(404);
    });

    it('never leaves a project without a project manager', async () => {
      const pm = await signIn(t);
      const dev = await signIn(t);
      const project = await createProject(pm);
      await addMember(project, pm, dev, 'DEVELOPER');
      const self = `/api/v1/projects/${project.id}/members/${pm.id}`;

      await t.http.patch(self).set(pm.auth).send({ role: 'DEVELOPER' }).expect(409);
      await t.http.delete(self).set(pm.auth).expect(409);

      // With a second manager, the first may step down.
      await t.http
        .patch(`/api/v1/projects/${project.id}/members/${dev.id}`)
        .set(pm.auth)
        .send({ role: 'PROJECT_MANAGER' })
        .expect(200);
      await t.http.patch(self).set(pm.auth).send({ role: 'DEVELOPER' }).expect(200);
    });

    it('keeps at least one manager even when two managers demote each other at once', async () => {
      const a = await signIn(t);
      const b = await signIn(t);
      const project = await createProject(a);
      await addMember(project, a, b, 'PROJECT_MANAGER');

      const results = await Promise.all([
        t.http
          .patch(`/api/v1/projects/${project.id}/members/${b.id}`)
          .set(a.auth)
          .send({ role: 'VIEWER' }),
        t.http
          .patch(`/api/v1/projects/${project.id}/members/${a.id}`)
          .set(b.auth)
          .send({ role: 'VIEWER' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      await expect(
        t.prisma.projectMember.count({
          where: { projectId: project.id, role: { key: 'PROJECT_MANAGER' } },
        }),
      ).resolves.toBe(1);
    });

    it('lets any member leave, but only managers remove others', async () => {
      const pm = await signIn(t);
      const dev = await signIn(t);
      const viewer = await signIn(t);
      const project = await createProject(pm);
      await addMember(project, pm, dev, 'DEVELOPER');
      await addMember(project, pm, viewer, 'VIEWER');

      await t.http
        .delete(`/api/v1/projects/${project.id}/members/${viewer.id}`)
        .set(dev.auth)
        .expect(403);
      await t.http
        .delete(`/api/v1/projects/${project.id}/members/${viewer.id}`)
        .set(viewer.auth)
        .expect(204);
      await expect(
        t.prisma.auditLog.count({
          where: { action: 'project.member.left', entityId: project.id, actorId: viewer.id },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('labels', () => {
    it('creates, renames, recolours and deletes labels; names are unique per project', async () => {
      const pm = await signIn(t);
      const project = await createProject(pm);
      const other = await createProject(pm);
      const url = `/api/v1/projects/${project.id}/labels`;

      const bug = await t.http
        .post(url)
        .set(pm.auth)
        .send({ name: 'Bug', color: '#D73A4A' })
        .expect(201);
      expect(bug.body).toMatchObject({ name: 'Bug', color: '#d73a4a', issueCount: 0 });

      await t.http.post(url).set(pm.auth).send({ name: 'bug', color: '#000000' }).expect(409);
      await t.http
        .post(`/api/v1/projects/${other.id}/labels`)
        .set(pm.auth)
        .send({ name: 'bug', color: '#000000' })
        .expect(201); // another project may reuse the name

      await t.http
        .patch(`/api/v1/labels/${bug.body.id as string}`)
        .set(pm.auth)
        .send({ name: 'defect', color: '#ff0000' })
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ name: 'defect', color: '#ff0000' });
        });

      const list = await t.http.get(url).set(pm.auth).expect(200);
      expect(list.body.map((l: { name: string }) => l.name)).toEqual(['defect']);

      await t.http
        .delete(`/api/v1/labels/${bug.body.id as string}`)
        .set(pm.auth)
        .expect(204);
      await t.http
        .get(url)
        .set(pm.auth)
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual([]);
        });
    });

    it('404s label operations for people outside the project', async () => {
      const pm = await signIn(t);
      const outsider = await signIn(t);
      const project = await createProject(pm);
      const label = await t.http
        .post(`/api/v1/projects/${project.id}/labels`)
        .set(pm.auth)
        .send({ name: 'x', color: '#000000' })
        .expect(201);

      await t.http
        .patch(`/api/v1/labels/${label.body.id as string}`)
        .set(outsider.auth)
        .send({ name: 'mine now' })
        .expect(404);
      await t.http
        .delete(`/api/v1/labels/${label.body.id as string}`)
        .set(outsider.auth)
        .expect(404);
    });
  });
});
