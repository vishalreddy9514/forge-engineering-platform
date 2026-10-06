import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request ID of the work in progress, so one ID follows a request from the browser through
 * the API, the queue and the worker to the AI service (architecture §11). HTTP requests take it
 * from X-Request-ID (or mint one); jobs carry it in their data.
 */
interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Job data (or an outbox payload) with the current request ID attached, for producers:
 * `queue.add(name, traced(data))`. The type is unchanged: the ID is metadata that only
 * runJob (instrumented.ts) reads.
 */
export function traced<T extends object>(data: T): T {
  const requestId = currentRequestId();
  return requestId ? { ...data, requestId } : data;
}
