import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import type { Env } from '../config/env';
import { createAppJwt } from './app-jwt';
import { GithubClient, rateLimitReset } from './github.client';
import { GithubApiError, GithubRateLimitError } from './github.errors';
import { GithubSettings } from './github.settings';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const API = 'https://api.github.test';

function settings(overrides: Partial<Env> = {}): GithubSettings {
  const env: Partial<Env> = {
    GITHUB_APP_ID: 42,
    GITHUB_APP_SLUG: 'forge-test',
    GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-of-some-length',
    GITHUB_API_URL: API,
    GITHUB_WEB_URL: 'https://github.test',
    GITHUB_RATE_LIMIT_RESERVE: 100,
    GITHUB_SYNC_MAX_PAGES: 3,
    ...overrides,
  };
  return new GithubSettings({
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>);
}

/** Enough of ioredis for the client: get/set with PX, and del. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const inAnHour = () => String(Math.floor(Date.now() / 1000) + 3600);
const tokenResponse = () =>
  json(
    { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    201,
  );

describe('createAppJwt', () => {
  it('is an RS256 JWT for the App, backdated a minute and valid under ten', () => {
    const now = Date.UTC(2026, 8, 27, 12, 0, 0);
    const [header, payload, signature] = createAppJwt(
      42,
      settings().require().privateKey,
      now,
    ).split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '42' });

    const verify = createVerify('RSA-SHA256');
    verify.update(`${header ?? ''}.${payload ?? ''}`);
    expect(verify.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
  });
});

describe('GithubClient', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let fetchMock: jest.SpyInstance;
  let client: GithubClient;

  beforeEach(() => {
    redis = fakeRedis();
    fetchMock = jest.spyOn(global, 'fetch');
    client = new GithubClient(settings(), redis as unknown as Redis);
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const calls = () => fetchMock.mock.calls.map(([url]) => String(url));
  const authOf = (i: number) =>
    ((fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)
      .Authorization;

  it('mints an installation token with the App JWT once, then reuses it from Redis', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ id: 1 }))
      .mockResolvedValueOnce(json({ id: 1 }));

    await client.get(7, '/repos/acme/app');
    await client.get(7, '/repos/acme/app');

    expect(calls()).toEqual([
      `${API}/app/installations/7/access_tokens`,
      `${API}/repos/acme/app`,
      `${API}/repos/acme/app`,
    ]);
    expect(authOf(0)).toMatch(/^Bearer eyJ/); // the App JWT
    expect(authOf(1)).toBe('Bearer ghs_installation');
    expect(authOf(2)).toBe('Bearer ghs_installation');
  });

  it('forgets a token GitHub rejects, so the retry mints a new one', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));

    await expect(client.get(7, '/repos/acme/app')).rejects.toMatchObject({ status: 401 });
    expect(redis.store.has('github:token:7')).toBe(false);
  });

  it('follows Link rel="next" until the last page', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    fetchMock
      .mockResolvedValueOnce(json([1, 2], 200, { link: `<${API}/items?page=2>; rel="next"` }))
      .mockResolvedValueOnce(json([3], 200, { link: `<${API}/items?page=1>; rel="prev"` }));

    const pages: unknown[][] = [];
    for await (const page of client.paginate(7, '/items', {}, { maxPages: 10 })) pages.push(page);

    expect(pages).toEqual([[1, 2], [3]]);
    expect(calls()[0]).toBe(`${API}/items?per_page=100`);
  });

  it('stops at maxPages', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    fetchMock.mockImplementation(() =>
      Promise.resolve(json([1], 200, { link: `<${API}/items?page=9>; rel="next"` })),
    );
    let pages = 0;
    for await (const _ of client.paginate(7, '/items', {}, { maxPages: 3 })) pages++;
    expect(pages).toBe(3);
  });

  it('never follows a pagination link to another host (it would leak the token)', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    fetchMock.mockResolvedValueOnce(
      json([1], 200, { link: '<https://evil.test/steal?page=2>; rel="next"' }),
    );
    const pages: unknown[][] = [];
    for await (const page of client.paginate(7, '/items', {}, { maxPages: 10 })) pages.push(page);
    expect(pages).toEqual([[1]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns an exhausted primary rate limit into GithubRateLimitError at the reset time', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    const reset = inAnHour();
    fetchMock.mockResolvedValueOnce(
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': reset,
      }),
    );
    const error = await client.get(7, '/repos/acme/app').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).resetAt.getTime()).toBe(Number(reset) * 1000);
  });

  it('treats a 403 that is not a rate limit as an ordinary error', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    fetchMock.mockResolvedValueOnce(
      json({ message: 'Resource not accessible by integration' }, 403, {
        'x-ratelimit-remaining': '4000',
      }),
    );
    const error = await client.get(7, '/repos/acme/app').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubApiError);
    expect((error as Error).message).toBe('GitHub 403: Resource not accessible by integration');
  });

  it('holds background calls back once the remaining quota reaches the reserve', async () => {
    redis.store.set('github:token:7', 'ghs_cached');
    const reset = inAnHour();
    fetchMock.mockResolvedValueOnce(
      json({ id: 1 }, 200, { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': reset }),
    );
    await client.get(7, '/repos/acme/app', {}, { background: true });

    // Recorded 100 remaining = the reserve: the next background call never reaches GitHub...
    await expect(client.get(7, '/repos/acme/app', {}, { background: true })).rejects.toEqual(
      new GithubRateLimitError(new Date(Number(reset) * 1000)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...while a call someone is waiting on may still use the reserve.
    fetchMock.mockResolvedValueOnce(json({ id: 1 }));
    await client.get(7, '/repos/acme/app');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps each installation’s quota separate', async () => {
    redis.store.set('github:token:7', 'ghs_7');
    redis.store.set('github:token:8', 'ghs_8');
    fetchMock.mockResolvedValueOnce(
      json([], 200, { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': inAnHour() }),
    );
    await client.get(7, '/a', {}, { background: true });
    fetchMock.mockResolvedValueOnce(json([]));
    await expect(client.get(8, '/a', {}, { background: true })).resolves.toEqual([]);
  });
});

describe('rateLimitReset', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  const headers = (h: Record<string, string>) => new Headers(h);

  it('prefers Retry-After (secondary limit)', () => {
    expect(rateLimitReset(headers({ 'retry-after': '30' }), '', now)).toEqual(
      new Date(now + 30_000),
    );
  });

  it('uses X-RateLimit-Reset when the primary limit is spent', () => {
    expect(
      rateLimitReset(
        headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790500000' }),
        '',
        now,
      ),
    ).toEqual(new Date(1790500000 * 1000));
  });

  it('waits a minute for a secondary limit reported only in the message', () => {
    expect(rateLimitReset(headers({}), 'You have exceeded a secondary rate limit.', now)).toEqual(
      new Date(now + 60_000),
    );
  });

  it('is null for a permission error', () => {
    expect(rateLimitReset(headers({ 'x-ratelimit-remaining': '10' }), 'Forbidden', now)).toBeNull();
  });
});

describe('GithubSettings', () => {
  it('builds the install link from the App slug', () => {
    expect(settings().installUrl()).toBe('https://github.test/apps/forge-test/installations/new');
  });

  it('is disabled without an App, and require() answers 503', () => {
    const disabled = settings({
      GITHUB_APP_ID: undefined,
      GITHUB_APP_SLUG: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });
    expect(disabled.app).toBeNull();
    expect(disabled.installUrl()).toBeNull();
    expect(() => disabled.require()).toThrow('The GitHub integration is not configured');
  });

  it('fails at startup on a malformed private key', () => {
    expect(() => settings({ GITHUB_APP_PRIVATE_KEY: 'not a key' })).toThrow();
  });
});
