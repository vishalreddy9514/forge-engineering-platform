import { randomBytes } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, request } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** A short random suffix, so data created by parallel tests never collides. */
export const unique = () => randomBytes(4).toString('hex');

/** A project key: an uppercase letter, then up to nine letters or digits. */
export const projectKey = () => `E${unique().toUpperCase().slice(0, 7)}`;

export interface User {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

/** Registers a new user through the API (as the register page would) and returns its token. */
export async function newUser(displayName = 'E2E User'): Promise<User> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const email = `e2e-${unique()}@example.test`;
    const res = await ctx.post('/api/v1/auth/register', {
      data: { email, displayName, password: PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { accessToken: string; user: { id: string } };
    return { id: body.user.id, email, displayName, token: body.accessToken };
  } finally {
    await ctx.dispose();
  }
}

/** Signs the page's browser context in as `user` (sets the refresh cookie, as the login form does). */
export async function signIn(page: Page, user: User): Promise<void> {
  const res = await page.request.post('/api/v1/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** JSON calls to the API as `user`, for arranging data a test is not about. */
export class Api {
  private constructor(
    private readonly ctx: APIRequestContext,
    readonly user: User,
  ) {}

  static async as(user: User): Promise<Api> {
    const ctx = await request.newContext({
      baseURL: `${BASE_URL}/api/v1/`,
      extraHTTPHeaders: { Authorization: `Bearer ${user.token}` },
    });
    return new Api(ctx, user);
  }

  async post<T>(path: string, data: unknown, status = 201): Promise<T> {
    const res = await this.ctx.post(path, { data });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(status);
    return (await res.json()) as T;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.ctx.get(path);
    expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
    return (await res.json()) as T;
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

export interface Project {
  id: string;
  key: string;
  name: string;
}

/** A project owned by `owner`, with the other users added in the given roles. */
export async function newProject(
  owner: User,
  members: [User, 'PROJECT_MANAGER' | 'DEVELOPER' | 'VIEWER'][] = [],
  name = 'E2E project',
): Promise<Project> {
  const api = await Api.as(owner);
  try {
    const project = await api.post<Project>('projects', { key: projectKey(), name });
    for (const [user, role] of members) {
      await api.post(`projects/${project.id}/members`, { email: user.email, role });
    }
    return project;
  } finally {
    await api.dispose();
  }
}

/**
 * WCAG 2.1 A and AA rules (NFR-13) on the current page. Fails with the rule, the impact and the
 * offending elements, so the report says what to fix.
 */
export async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = violations.map(
    (v) =>
      `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n${v.nodes
        .slice(0, 5)
        .map(
          (n) =>
            `    ${n.html.slice(0, 160)}\n      ${(n.failureSummary ?? '').replace(/\n/g, ' ').slice(0, 240)}`,
        )
        .join('\n')}`,
  );
  expect(summary, `axe found WCAG violations on ${page.url()}`).toEqual([]);
}
