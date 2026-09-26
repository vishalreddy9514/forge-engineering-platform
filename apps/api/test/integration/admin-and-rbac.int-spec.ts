import { AccessControlService } from '../../src/access-control/access-control.service';
import { hashPassword } from '../../src/common/security/password-hasher';
import { createIssue, ROLE, uid } from './helpers';
import { createTestApp, RbacProbeController, refreshCookie, type TestApp } from './test-app';

const PASSWORD = 'correct horse battery staple';

describe('admin user management and project RBAC (HTTP, real Postgres + Redis)', () => {
  let t: TestApp;
  let passwordHash: string;

  beforeAll(async () => {
    t = await createTestApp([RbacProbeController]);
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.redis.flushdb();
  });

  /** Creates a user directly in the database and signs in through the API. */
  async function signedIn(options: { isAdmin?: boolean } = {}) {
    const email = `u-${uid()}@example.test`;
    const user = await t.prisma.user.create({
      data: { email, displayName: 'User', passwordHash, isAdmin: options.isAdmin ?? false },
    });
    const res = await t.http
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      id: user.id,
      email,
      token: res.body.accessToken as string,
      cookie: refreshCookie(res) ?? '',
      auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    };
  }

  const pause = () => new Promise((resolve) => setTimeout(resolve, 1100));

  describe('admin endpoints', () => {
    it('are forbidden to regular users', async () => {
      const user = await signedIn();
      await t.http.get('/api/v1/admin/users').set(user.auth).expect(403);
    });

    it('list users with keyset pagination and search', async () => {
      const admin = await signedIn({ isAdmin: true });
      const tag = uid();
      for (let i = 0; i < 3; i++) {
        await t.prisma.user.create({
          data: {
            email: `page-${tag}-${i}@example.test`,
            displayName: `Paged ${tag}`,
            passwordHash,
          },
        });
      }

      const first = await t.http
        .get(`/api/v1/admin/users?q=${tag}&limit=2`)
        .set(admin.auth)
        .expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect(first.body.data[0]).not.toHaveProperty('passwordHash');

      const second = await t.http
        .get(`/api/v1/admin/users?q=${tag}&limit=2&cursor=${first.body.nextCursor as string}`)
        .set(admin.auth)
        .expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();

      const ids = [...first.body.data, ...second.body.data].map((u: { id: string }) => u.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('deactivating a user cuts them off immediately: access token, refresh and login', async () => {
      const admin = await signedIn({ isAdmin: true });
      const user = await signedIn();
      await pause(); // user's token must predate the revocation second

      await t.http
        .patch(`/api/v1/admin/users/${user.id}`)
        .set(admin.auth)
        .send({ isActive: false })
        .expect(200);

      await t.http.get('/api/v1/users/me').set(user.auth).expect(401);
      await t.http
        .post('/api/v1/auth/refresh')
        .set('Cookie', `forge_rt=${user.cookie}`)
        .expect(401);
      await t.http
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(401);

      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.user.updated', entityId: user.id },
      });
      expect(audit.actorId).toBe(admin.id);
      expect(audit.metadata).toEqual({
        before: { isActive: true, isAdmin: false },
        after: { isActive: false, isAdmin: false },
      });
    });

    it('a demoted admin loses admin access at once, even with an unexpired token', async () => {
      const admin = await signedIn({ isAdmin: true });
      const other = await signedIn({ isAdmin: true });
      await pause();

      await t.http
        .patch(`/api/v1/admin/users/${other.id}`)
        .set(admin.auth)
        .send({ isAdmin: false })
        .expect(200);
      await t.http.get('/api/v1/admin/users').set(other.auth).expect(401);

      // After refreshing, the new token reflects the demotion.
      const refreshed = await t.http
        .post('/api/v1/auth/refresh')
        .set('Cookie', `forge_rt=${other.cookie}`)
        .expect(200);
      expect(refreshed.body.user.isAdmin).toBe(false);
      await t.http
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${refreshed.body.accessToken as string}`)
        .expect(403);
    });

    it('prevents admins from changing their own status', async () => {
      const admin = await signedIn({ isAdmin: true });
      await t.http
        .patch(`/api/v1/admin/users/${admin.id}`)
        .set(admin.auth)
        .send({ isAdmin: false })
        .expect(400);
    });
  });

  describe('project permissions (ProjectAccessGuard)', () => {
    type Actor = 'pm' | 'developer' | 'viewer' | 'outsider' | 'admin';

    async function world() {
      const [pm, developer, viewer, outsider, admin] = await Promise.all([
        signedIn(),
        signedIn(),
        signedIn(),
        signedIn(),
        signedIn({ isAdmin: true }),
      ]);
      const project = await t.prisma.project.create({
        data: {
          key: `R${uid().toUpperCase()}`.slice(0, 10),
          name: 'RBAC',
          createdById: pm.id,
          members: {
            create: [
              { userId: pm.id, roleId: ROLE.PROJECT_MANAGER },
              { userId: developer.id, roleId: ROLE.DEVELOPER },
              { userId: viewer.id, roleId: ROLE.VIEWER },
            ],
          },
        },
      });
      const issue = await createIssue(t.prisma, project.id, pm.id);
      const actors: Record<Actor, { auth: Record<string, string>; id: string }> = {
        pm,
        developer,
        viewer,
        outsider,
        admin,
      };
      return { project, issue, actors };
    }

    // Expected status per route and actor. Outsiders get 404 (existence not revealed).
    const cases: [string, 'get' | 'post' | 'delete', Record<Actor, number>][] = [
      ['read project', 'get', { pm: 200, developer: 200, viewer: 200, outsider: 404, admin: 200 }],
      ['create issue', 'post', { pm: 201, developer: 201, viewer: 403, outsider: 404, admin: 201 }],
      [
        'manage members',
        'post',
        { pm: 201, developer: 403, viewer: 403, outsider: 404, admin: 201 },
      ],
      [
        'delete issue',
        'delete',
        { pm: 204, developer: 403, viewer: 403, outsider: 404, admin: 204 },
      ],
    ];

    it.each(cases)('%s', async (name, method, expected) => {
      const { project, issue, actors } = await world();
      const path = {
        'read project': `/api/v1/_probe/projects/${project.id}`,
        'create issue': `/api/v1/_probe/projects/${project.id}/issues`,
        'manage members': `/api/v1/_probe/projects/${project.id}/members`,
        'delete issue': `/api/v1/_probe/issues/${issue.id}`,
      }[name];
      if (!path) throw new Error(`no path for ${name}`);

      for (const [actor, status] of Object.entries(expected) as [Actor, number][]) {
        const res = await t.http[method](path).set(actors[actor].auth);
        expect({ actor, status: res.status }).toEqual({ actor, status });
      }
    });

    it('answers 404 for malformed IDs and for soft-deleted issues', async () => {
      const { issue, actors } = await world();
      await t.http.get('/api/v1/_probe/projects/not-a-uuid').set(actors.pm.auth).expect(404);

      await t.prisma.issue.update({ where: { id: issue.id }, data: { deletedAt: new Date() } });
      await t.http.delete(`/api/v1/_probe/issues/${issue.id}`).set(actors.pm.auth).expect(404);
    });

    it('applies a role change once the membership cache entry is invalidated', async () => {
      const { project, actors } = await world();
      const createIssuePath = `/api/v1/_probe/projects/${project.id}/issues`;
      await t.http.post(createIssuePath).set(actors.viewer.auth).expect(403); // cached as VIEWER

      await t.prisma.projectMember.update({
        where: { projectId_userId: { projectId: project.id, userId: actors.viewer.id } },
        data: { roleId: ROLE.DEVELOPER },
      });
      await t.app.get(AccessControlService).invalidate(project.id, actors.viewer.id);

      await t.http.post(createIssuePath).set(actors.viewer.auth).expect(201);
    });
  });
});
