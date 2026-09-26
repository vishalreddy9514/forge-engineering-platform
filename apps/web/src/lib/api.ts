import { ProblemDetails } from '@forge/types';

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
 * Minimal same-origin fetch wrapper. Authentication (in-memory access token, refresh on 401)
 * is added in Phase 4; this only establishes the error contract.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // HeadersInit may be an object, a Headers instance or an array of pairs; Headers handles all.
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (!res.ok && res.status !== 503) {
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = ProblemDetails.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data : undefined);
  }
  return res;
}
