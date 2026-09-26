import type { PrismaClient } from '../../src/generated/prisma/client';
import { PG, createPrisma, createUser, sqlState } from './helpers';

describe('audit log and outbox', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('audit_logs is append-only', () => {
    async function entry() {
      const actor = await createUser(prisma);
      return prisma.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'auth.login.succeeded',
          ipAddress: '203.0.113.7',
          requestId: 'req-123',
        },
      });
    }

    it('accepts inserts', async () => {
      const log = await entry();
      expect(log.id).toEqual(expect.any(BigInt));
    });

    it('rejects UPDATE', async () => {
      const log = await entry();
      await expect(
        sqlState(prisma.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } })),
      ).resolves.toBe(PG.INSUFFICIENT_PRIVILEGE);
    });

    it('rejects DELETE', async () => {
      const log = await entry();
      await expect(sqlState(prisma.auditLog.delete({ where: { id: log.id } }))).resolves.toBe(
        PG.INSUFFICIENT_PRIVILEGE,
      );
    });

    it('rejects TRUNCATE', async () => {
      await entry();
      await expect(sqlState(prisma.$executeRaw`TRUNCATE audit_logs`)).resolves.toBe(
        PG.INSUFFICIENT_PRIVILEGE,
      );
    });

    it('keeps the actor alive: a user with audit history cannot be hard-deleted', async () => {
      const log = await entry();
      await expect(
        sqlState(prisma.user.delete({ where: { id: log.actorId ?? '' } })),
      ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
    });
  });

  describe('outbox relay query', () => {
    it('claims unpublished events oldest first and skips rows locked by another relay', async () => {
      const aggregateId = `issue-${Date.now()}`;
      await prisma.outboxEvent.createMany({
        data: [1, 2, 3].map((n) => ({
          aggregateType: 'issue',
          aggregateId,
          eventType: `test.event.${n}`,
          payload: { n },
        })),
      });

      // Relay A claims the oldest event and holds the lock; relay B must skip it, not wait.
      await prisma.$transaction(async (relayA) => {
        const [claimedByA] = await relayA.$queryRaw<{ event_type: string }[]>`
          SELECT event_type FROM outbox_events
          WHERE published_at IS NULL AND aggregate_id = ${aggregateId}
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;

        const claimedByB = await prisma.$transaction(
          (relayB) => relayB.$queryRaw<{ event_type: string }[]>`
            SELECT event_type FROM outbox_events
            WHERE published_at IS NULL AND aggregate_id = ${aggregateId}
            ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`,
        );

        expect(claimedByA?.event_type).toBe('test.event.1');
        expect(claimedByB.map((row) => row.event_type)).toEqual(['test.event.2', 'test.event.3']);
      });
    });
  });
});
