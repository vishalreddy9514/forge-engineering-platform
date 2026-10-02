import type { Prisma } from '../generated/prisma/client';
import type { DomainEvents, DomainEventType, IndexedSourceType } from './outbox.events';

/**
 * Records a domain event in the same transaction as the change it describes: the event exists
 * if and only if the change committed. The relay publishes it to the queues afterwards.
 */
export async function writeOutbox<T extends DomainEventType>(
  tx: Prisma.TransactionClient,
  type: T,
  aggregate: { type: 'issue' | 'sprint' | 'pull_request' | 'document'; id: string },
  payload: DomainEvents[T],
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: aggregate.type,
      aggregateId: aggregate.id,
      eventType: type,
      payload,
    },
  });
}

/**
 * Queues a re-index of a searchable source after this transaction commits (FR-8.3). The job
 * reads the source's state then, so the same call covers create, edit and delete.
 */
export function indexLater(
  tx: Prisma.TransactionClient,
  sourceType: IndexedSourceType,
  sourceId: string,
  aggregate: { type: 'issue' | 'document'; id: string } = {
    type: sourceType === 'UPLOAD' ? 'document' : 'issue',
    id: sourceId,
  },
): Promise<void> {
  return writeOutbox(tx, 'search.index', aggregate, { sourceType, sourceId });
}
