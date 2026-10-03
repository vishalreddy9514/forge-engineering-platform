import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import { currentRequestId } from './request-context';

/**
 * Error reporting to Sentry (architecture §11), on only when SENTRY_DSN is set. Reports carry
 * the request ID, service, route or queue, and the stack. Never credentials or personal data:
 * no headers that authenticate, no bodies (issue text, comments), no query strings, no user.
 */
const DROPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-forwarded-for',
  'referer',
  'x-hub-signature-256',
]);

const withoutQuery = (url: string) => url.split('?')[0] ?? url;

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const { request } = event;
  if (request) {
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !DROPPED_HEADERS.has(name.toLowerCase()),
        ),
      );
    }
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.url) request.url = withoutQuery(request.url);
  }
  delete event.user;
  event.breadcrumbs = event.breadcrumbs?.map((crumb) =>
    typeof crumb.data?.url === 'string'
      ? { ...crumb, data: { ...crumb.data, url: withoutQuery(crumb.data.url) } }
      : crumb,
  );
  return event;
}

export function initErrorReporting(
  service: 'api' | 'worker',
  env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string; SENTRY_RELEASE?: string } = process.env,
): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    // Collect nothing personal at the source; scrubEvent is the second line of defence.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ['user-agent', 'content-type', 'x-request-id'] },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
    },
    // Errors only: traces and performance data stay in Prometheus.
    tracesSampleRate: 0,
    initialScope: { tags: { service } },
    beforeSend: scrubEvent,
  });
  return true;
}

/** Reports an unexpected error with the current request ID and any tags (no-op when off). */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  if (!Sentry.isEnabled()) return;
  Sentry.withScope((scope) => {
    const requestId = currentRequestId();
    if (requestId) scope.setTag('request_id', requestId);
    scope.setTags(tags);
    Sentry.captureException(error);
  });
}

/** Sends what is queued before the process exits (SIGTERM from ECS, Ctrl+C). */
export async function flushErrorReports(): Promise<void> {
  if (Sentry.isEnabled()) await Sentry.close(2_000);
}
