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
}
export type DomainEventType = keyof DomainEvents;

/** Which queues receive each event type. Indexing (Phase 10) subscribes here too. */
export const EVENT_ROUTES: Record<DomainEventType, readonly string[]> = {
  'issue.assigned': [QUEUES.NOTIFICATIONS],
  'comment.added': [QUEUES.NOTIFICATIONS],
  'sprint.started': [QUEUES.NOTIFICATIONS],
  'sprint.completed': [QUEUES.NOTIFICATIONS],
};

/** What a processor receives: the event payload plus the outbox row it came from. */
export type OutboxJob<T extends DomainEventType> = DomainEvents[T] & { outboxId: string };

export function isDomainEventType(value: string): value is DomainEventType {
  return value in EVENT_ROUTES;
}
