import { AuthResponse, ProblemDetails } from '@forge/types';
import type { z } from 'zod';

/** Error thrown for non-2xx API responses, carrying the RFC 9457 body when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem?: ProblemDetails,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

/**
 * The access token lives only in this module's memory (ADR-0003): never in localStorage, so an
 * XSS payload cannot read a stored credential. A reload loses it; the httpOnly refresh cookie
 * gets a new one.
 */
let accessToken: string | null = null;
let onSessionExpired: (() => void) | undefined;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Called when a request needed a session and none could be restored. */
export function setSessionExpiredHandler(handler: (() => void) | undefined): void {
  onSessionExpired = handler;
}

let refreshInFlight: Promise<AuthResponse | null> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Single-flight: concurrent callers (e.g.
 * five queries that all got a 401) share one refresh, because the server rotates the cookie on
 * every use.
 */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(attempt = 1): Promise<AuthResponse | null> {
  const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  // 409: another tab refreshed a moment ago; our cookie jar now holds its new cookie.
  if (res.status === 409 && attempt === 1) return doRefresh(2);
  if (!res.ok) {
    setAccessToken(null);
    return null;
  }
  const session = AuthResponse.parse(await res.json());
  setAccessToken(session.accessToken);
  return session;
}

interface FetchOptions {
  /** Attach the access token and refresh on 401 (default true). */
  auth?: boolean;
  /** Treat these statuses as data instead of errors (e.g. 503 from readiness). */
  acceptStatuses?: number[];
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  { auth = true, acceptStatuses = [] }: FetchOptions = {},
): Promise<Response> {
  const send = () => {
    // HeadersInit may be an object, a Headers instance or an array of pairs; Headers handles all.
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (auth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  };

  let res = await send();
  if (res.status === 401 && auth) {
    const session = await refreshSession();
    if (session) {
      res = await send();
    } else {
      onSessionExpired?.();
    }
  }

  if (!res.ok && !acceptStatuses.includes(res.status)) {
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = ProblemDetails.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data : undefined);
  }
  return res;
}

/** JSON request whose response is validated against `schema`. */
export async function apiJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
  options?: FetchOptions,
): Promise<T> {
  const res = await apiFetch(path, init, options);
  return schema.parse(await res.json());
}
