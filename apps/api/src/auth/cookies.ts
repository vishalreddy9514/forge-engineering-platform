import { SESSION_HINT_COOKIE } from '@forge/types';
import type { CookieOptions, Response } from 'express';

export const REFRESH_COOKIE = 'forge_rt';
/** The refresh cookie is only ever sent to the auth endpoints, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setSessionCookies(
  res: Response,
  refreshToken: string,
  expiresAt: Date,
  secure: boolean,
): void {
  const base: CookieOptions = { secure, sameSite: 'strict', expires: expiresAt };
  // httpOnly: page scripts (and therefore XSS) cannot read it.
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, path: REFRESH_COOKIE_PATH });
  // Non-secret hint readable by the web app's proxy for redirects; carries no credential.
  res.cookie(SESSION_HINT_COOKIE, '1', { ...base, httpOnly: false, path: '/' });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(SESSION_HINT_COOKIE, { secure, sameSite: 'strict', path: '/' });
}

export function readRefreshCookie(cookies: unknown): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
