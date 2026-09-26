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
