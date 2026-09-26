import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept an upstream ID only if it is short and made of safe characters (no log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Reuse the request ID assigned by the proxy/load balancer (or a calling service) so one ID
 * follows the request across services, otherwise generate one. Echoed on the response.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
