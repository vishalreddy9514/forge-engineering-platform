import type { Prisma } from '../generated/prisma/client';
import type { DomainEvents, DomainEventType } from './outbox.events';

/**
 * Records a domain event in the same transaction as the change it describes: the event exists
 * if and only if the change committed. The relay publishes it to the queues afterwards.
 */
export async function writeOutbox<T extends DomainEventType>(
  tx: Prisma.TransactionClient,
  type: T,
  aggregate: { type: 'issue' | 'sprint' | 'pull_request'; id: string },
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
