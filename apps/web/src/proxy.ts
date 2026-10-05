import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy, createNonce, storageOrigin } from './lib/security-headers';

/** Must match SESSION_HINT_COOKIE in @forge/types (kept literal to keep the proxy dependency-free). */
const SESSION_HINT_COOKIE = 'forge_session';
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];
const GUEST_ONLY_PATHS = ['/login', '/register'];

const matches = (path: string, list: string[]) =>
  list.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Routing convenience, not a security boundary: the hint cookie only says a session probably
 * exists. Every API call is still authorised by the API itself.
 *
 * Also issues each page's Content Security Policy with a fresh nonce. Next.js reads the policy
 * from the request headers and puts the nonce on the scripts it renders.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_HINT_COOKIE);
  // A file name (robots.txt, sitemap.xml): no sign-in redirect, but still a policy, since the
  // answer may be an HTML page (the 404 page).
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return withContentSecurityPolicy(request);

  if (!hasSession && !matches(pathname, PUBLIC_PATHS)) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  if (hasSession && matches(pathname, GUEST_ONLY_PATHS)) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return withContentSecurityPolicy(request);
}

function withContentSecurityPolicy(request: NextRequest) {
  const policy = contentSecurityPolicy({
    nonce: createNonce(),
    dev: process.env.NODE_ENV === 'development',
    storageOrigin: storageOrigin(process.env),
  });
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  // Skip API calls and Next.js's own assets (scripts and styles are not documents).
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
