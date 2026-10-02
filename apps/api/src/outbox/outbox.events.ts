import { QUEUES } from '../infrastructure/queue/queue.module';

/**
 * Domain events written to the transactional outbox (ADR-0006). Payloads carry IDs, not
 * snapshots: processors load current state, so a stale event (the issue was reassigned again,
 * or deleted) is recognised and skipped instead of acted on.
 */
export interface DomainEvents {
  'issue.assigned': { issueId: string; assigneeId: string; actorId: string };
  'comment.added': { issueId: string; commentId: string; actorId: string };
  'sprint.started': { sprintId: string; actorId: string };
  'sprint.completed': { sprintId: string; actorId: string };
  /** A newly synced open PR mentions these issues (FR-6.4). No Forge user is the actor. */
  'pull_request.opened': { pullRequestId: string; issueIds: string[] };
  /** A searchable source changed or was deleted: re-index it from its current state (FR-8.3). */
  'search.index': { sourceType: IndexedSourceType; sourceId: string };
}
/** Sources whose writes go through the outbox; PRs and commits are indexed after GitHub syncs. */
export type IndexedSourceType = 'ISSUE' | 'COMMENT' | 'UPLOAD';
export type DomainEventType = keyof DomainEvents;

/** Which queues receive each event type. */
export const EVENT_ROUTES: Record<DomainEventType, readonly string[]> = {
  'issue.assigned': [QUEUES.NOTIFICATIONS],
  'comment.added': [QUEUES.NOTIFICATIONS],
  'sprint.started': [QUEUES.NOTIFICATIONS],
  'sprint.completed': [QUEUES.NOTIFICATIONS],
  'pull_request.opened': [QUEUES.NOTIFICATIONS],
  'search.index': [QUEUES.INDEXING],
};

/**
 * Events about the same thing that collapse into one job. Indexing reads the source's current
 * state, so ten quick edits need one run, not ten: while a job for the source is waiting, new
 * events join it, and while one is running, at most one more is kept to run after it (so the
 * last edit is never lost to a run that read the state before it).
 */
export const EVENT_DEDUPLICATION: Partial<{
  [T in DomainEventType]: (payload: DomainEvents[T]) => string;
}> = {
  'search.index': (payload) => `index:${payload.sourceType}:${payload.sourceId}`,
};

/** What a processor receives: the event payload plus the outbox row it came from. */
export type OutboxJob<T extends DomainEventType> = DomainEvents[T] & { outboxId: string };

export function isDomainEventType(value: string): value is DomainEventType {
  return value in EVENT_ROUTES;
}
