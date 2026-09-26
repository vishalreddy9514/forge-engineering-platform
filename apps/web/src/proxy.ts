import { NextResponse, type NextRequest } from 'next/server';

/** Must match SESSION_HINT_COOKIE in @forge/types (kept literal to keep the proxy dependency-free). */
const SESSION_HINT_COOKIE = 'forge_session';
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];
const GUEST_ONLY_PATHS = ['/login', '/register'];

const matches = (path: string, list: string[]) =>
  list.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Routing convenience, not a security boundary: the hint cookie only says a session probably
 * exists. Every API call is still authorised by the API itself.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_HINT_COOKIE);

  if (!hasSession && !matches(pathname, PUBLIC_PATHS)) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  if (hasSession && matches(pathname, GUEST_ONLY_PATHS)) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Skip API calls, Next.js internals and static files.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
