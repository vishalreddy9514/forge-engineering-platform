import { verifyPassword } from '../../src/common/security/password-hasher';
import { uid } from './helpers';
import { createTestApp, refreshCookie, setCookieHeader, type TestApp } from './test-app';

const PASSWORD = 'correct horse battery staple';
const WEB = 'http://localhost:3000';

describe('authentication (HTTP, real Postgres + Redis)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    // Rate-limit and lockout counters are per IP, and every request comes from 127.0.0.1.
    await t.redis.flushdb();
  });

  async function register(overrides: Partial<{ email: string; password: string }> = {}) {
    const email = overrides.email ?? `user-${uid()}@example.test`;
    const res = await t.http
      .post('/api/v1/auth/register')
      .send({ email, displayName: 'Test User', password: overrides.password ?? PASSWORD })
      .expect(201);
    return {
      email,
      userId: res.body.user.id as string,
      accessToken: res.body.accessToken as string,
      cookie: refreshCookie(res) ?? '',
    };
  }

  const refresh = (cookie: string, origin: string | null = WEB) => {
    const req = t.http.post('/api/v1/auth/refresh').set('Cookie', `forge_rt=${cookie}`);
    return origin ? req.set('Origin', origin) : req;
  };

  const me = (token: string) =>
    t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);

  describe('register', () => {
    it('creates the account, starts a session and sets hardened cookies', async () => {
      const email = `New.User-${uid()}@Example.TEST`;
      const res = await t.http
        .post('/api/v1/auth/register')
        .send({ email, displayName: '  Ada  ', password: PASSWORD })
        .expect(201);

      expect(res.body).toMatchObject({
        expiresIn: 900,
        user: { email: email.toLowerCase(), displayName: 'Ada', isAdmin: false },
      });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      expect(res.body.accessToken.split('.')).toHaveLength(3);

      const rt = setCookieHeader(res, 'forge_rt') ?? '';
      expect(rt).toMatch(/HttpOnly/);
      expect(rt).toMatch(/Secure/);
      expect(rt).toMatch(/SameSite=Strict/);
      expect(rt).toMatch(/Path=\/api\/v1\/auth/);
      expect(setCookieHeader(res, 'forge_session')).not.toMatch(/HttpOnly/);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      await expect(verifyPassword(user.passwordHash, PASSWORD)).resolves.toBe(true);
      await expect(
        t.prisma.auditLog.count({ where: { actorId: user.id, action: 'auth.register' } }),
      ).resolves.toBe(1);
    });

    it('rejects a duplicate email regardless of case', async () => {
      const { email } = await register();
      await t.http
        .post('/api/v1/auth/register')
        .send({ email: email.toUpperCase(), displayName: 'Dup', password: PASSWORD })
        .expect(409);
    });

    it('ignores fields a client should not be able to set (no mass assignment)', async () => {
      const email = `sneaky-${uid()}@example.test`;
      const res = await t.http
        .post('/api/v1/auth/register')
        .send({ email, displayName: 'Sneaky', password: PASSWORD, isAdmin: true })
        .expect(201);
      expect(res.body.user.isAdmin).toBe(false);
    });
  });

  describe('login', () => {
    it('returns a working access token and records the login', async () => {
      const { email, userId } = await register();
      const res = await t.http
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      const profile = await me(res.body.accessToken).expect(200);
      expect(profile.body).toMatchObject({ id: userId, email });
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const { email } = await register();
      const wrongPassword = await t.http
        .post('/api/v1/auth/login')
        .send({ email, password: 'not the password' })
        .expect(401);
      const unknownEmail = await t.http
        .post('/api/v1/auth/login')
        .send({ email: `nobody-${uid()}@example.test`, password: PASSWORD })
        .expect(401);
      expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
    });

    it('locks an account after 5 failures, even for the right password, then says when to retry', async () => {
      const { email } = await register();
      for (let i = 0; i < 5; i++) {
        await t.http
          .post('/api/v1/auth/login')
          .send({ email, password: `wrong-${i}` })
          .expect(401);
      }
      const locked = await t.http
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('locks unknown emails the same way, so lockout does not reveal which accounts exist', async () => {
      const email = `ghost-${uid()}@example.test`;
      for (let i = 0; i < 5; i++) {
        await t.http.post('/api/v1/auth/login').send({ email, password: 'x' }).expect(401);
      }
      await t.http.post('/api/v1/auth/login').send({ email, password: 'x' }).expect(429);
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new access token and rotates the refresh cookie', async () => {
      const { cookie } = await register();
      const res = await refresh(cookie).expect(200);

      const next = refreshCookie(res);
      expect(next).toBeDefined();
      expect(next).not.toBe(cookie);
      await me(res.body.accessToken).expect(200);
    });

    it('treats an immediate second use as a benign race: 409 to retry, session intact', async () => {
      const { cookie } = await register();
      const first = await refresh(cookie).expect(200);

      const second = await refresh(cookie).expect(409);
      expect(setCookieHeader(second, 'forge_rt')).toBeUndefined(); // cookies not cleared
      await refresh(refreshCookie(first) ?? '').expect(200); // winner's token still works
    });

    it('revokes the whole session family when a rotated token is replayed later (theft)', async () => {
      const { cookie, userId } = await register();
      const first = await refresh(cookie).expect(200);
      // Move the first use outside the race grace window, as if an attacker replayed it later.
      await t.prisma.refreshToken.updateMany({
        where: { userId, usedAt: { not: null } },
        data: { usedAt: new Date(Date.now() - 60_000) },
      });

      await refresh(cookie).expect(401);
      // The legitimate holder's newer token is dead too: both parties must sign in again.
      await refresh(refreshCookie(first) ?? '').expect(401);
      await expect(
        t.prisma.auditLog.count({
          where: { actorId: userId, action: 'auth.refresh.reuse_detected' },
        }),
      ).resolves.toBe(1);
    });

    it('rejects refresh requests from another site (CSRF)', async () => {
      const { cookie } = await register();
      await refresh(cookie, 'https://evil.example').expect(403);
      await refresh(cookie, null).expect(200); // non-browser clients send no Origin
    });

    it('rejects an unknown token and clears the cookies', async () => {
      const res = await refresh('not-a-real-token').expect(401);
      expect(setCookieHeader(res, 'forge_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
  });

  describe('logout', () => {
    it('ends this session only', async () => {
      const { email } = await register();
      const deviceA = refreshCookie(
        await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200),
      );
      const deviceB = refreshCookie(
        await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200),
      );

      await t.http
        .post('/api/v1/auth/logout')
        .set('Origin', WEB)
        .set('Cookie', `forge_rt=${deviceA ?? ''}`)
        .expect(204);

      await refresh(deviceA ?? '').expect(401);
      await refresh(deviceB ?? '').expect(200);
    });

    it('logout-all ends every session and invalidates access tokens immediately', async () => {
      const { email, accessToken } = await register();
      const other = refreshCookie(
        await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200),
      );
      // iat has one-second resolution; make sure the token predates the revocation cutoff.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await t.http
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      await me(accessToken).expect(401);
      await refresh(other ?? '').expect(401);
    });
  });

  describe('password reset', () => {
    async function latestResetUrl(email: string): Promise<URL | undefined> {
      const jobs = await t.emailQueue.getJobs(['waiting', 'delayed']);
      const job = jobs.find((j) => (j.data as { to: string }).to === email);
      return job ? new URL((job.data as { resetUrl: string }).resetUrl) : undefined;
    }

    it('answers identically for known and unknown emails, but only emails real accounts', async () => {
      const { email } = await register();
      const unknown = `nobody-${uid()}@example.test`;

      const a = await t.http
        .post('/api/v1/auth/password-reset/request')
        .send({ email })
        .expect(202);
      const b = await t.http
        .post('/api/v1/auth/password-reset/request')
        .send({ email: unknown })
        .expect(202);

      expect(a.body).toEqual(b.body);
      expect(await latestResetUrl(email)).toBeDefined();
      expect(await latestResetUrl(unknown)).toBeUndefined();
    });

    it('sets a new password once, signs out every session, and cannot be replayed', async () => {
      const { email, accessToken, cookie } = await register();
      await t.http.post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
      const url = await latestResetUrl(email);
      expect(url?.origin).toBe(WEB);
      expect(url?.pathname).toBe('/reset-password');
      const token = url?.searchParams.get('token') ?? '';
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const newPassword = 'a brand new passphrase';
      await t.http
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token, newPassword })
        .expect(204);

      await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401);
      await t.http.post('/api/v1/auth/login').send({ email, password: newPassword }).expect(200);
      await refresh(cookie).expect(401);
      await me(accessToken).expect(401);

      await t.http
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token, newPassword: 'yet another passphrase' })
        .expect(400);
    });

    it('rejects an expired link', async () => {
      const { email, userId } = await register();
      await t.http.post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
      const token = (await latestResetUrl(email))?.searchParams.get('token') ?? '';
      await t.prisma.passwordResetToken.updateMany({
        where: { userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await t.http
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token, newPassword: 'a brand new passphrase' })
        .expect(400);
    });
  });

  describe('profile and password change', () => {
    it('updates the profile but never fields outside the allow-list', async () => {
      const { accessToken } = await register();
      const res = await t.http
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ displayName: 'Renamed', isAdmin: true, email: 'hijack@example.test' })
        .expect(200);
      expect(res.body).toMatchObject({ displayName: 'Renamed', isAdmin: false });
      expect(res.body.email).not.toBe('hijack@example.test');
    });

    it('requires the current password, then signs out other sessions', async () => {
      const { email, accessToken } = await register();
      const other = refreshCookie(
        await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200),
      );

      const wrong = await t.http
        .post('/api/v1/users/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'not it at all', newPassword: 'a brand new passphrase' })
        .expect(400);
      expect(wrong.body.errors).toEqual([
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ]);

      const changed = await t.http
        .post('/api/v1/users/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'a brand new passphrase' })
        .expect(200);

      await me(changed.body.accessToken).expect(200); // this session continues
      await refresh(other ?? '').expect(401); // the other one is gone
    });
  });
});
