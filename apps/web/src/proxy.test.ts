/** @jest-environment node */
import { NextRequest } from 'next/server';

import { proxy } from './proxy';

function run(path: string, withSession: boolean) {
  const request = new NextRequest(new URL(path, 'http://localhost:3000'), {
    headers: withSession ? { cookie: 'forge_session=1' } : {},
  });
  return proxy(request);
}

describe('proxy (session-hint redirects)', () => {
  it('sends visitors without a session to sign in, remembering where they were going', () => {
    const res = run('/projects/PAY?tab=board', false);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/projects/PAY?tab=board');
  });

  it('lets anyone reach the public auth pages', () => {
    expect(run('/login', false).headers.get('location')).toBeNull();
    expect(run('/reset-password', false).headers.get('location')).toBeNull();
  });

  it('keeps signed-in users away from the sign-in and sign-up pages', () => {
    expect(new URL(run('/login', true).headers.get('location') ?? '').pathname).toBe('/');
  });

  it('lets signed-in users through to the app', () => {
    expect(run('/', true).headers.get('location')).toBeNull();
  });
});

describe('proxy (Content Security Policy)', () => {
  const policyOf = (res: Response) => res.headers.get('content-security-policy') ?? '';
  const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1];

  it('gives every page a policy whose scripts need this response’s nonce', () => {
    const policy = policyOf(run('/', true));
    expect(policy).toContain("script-src 'nonce-");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it('uses a fresh, unguessable nonce for every response', () => {
    const first = nonceOf(policyOf(run('/', true)));
    const second = nonceOf(policyOf(run('/', true)));
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(second).not.toBe(first);
  });

  it('covers file-like paths too, whose answer may be the HTML 404 page, without redirecting', () => {
    const res = run('/sitemap.xml', false);
    expect(res.headers.get('location')).toBeNull();
    expect(policyOf(res)).toContain("script-src 'nonce-");
  });

  it('passes the policy to Next.js on the request, so it can put the nonce on its scripts', () => {
    const res = run('/login', false);
    // NextResponse.next({ request: { headers } }) records overridden request headers here.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(policyOf(res));
  });
});
