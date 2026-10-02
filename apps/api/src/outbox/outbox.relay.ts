import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobsOptions, Queue } from 'bullmq';
import { Client } from 'pg';

import type { Env } from '../config/env';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { EVENT_DEDUPLICATION, EVENT_ROUTES, isDomainEventType } from './outbox.events';

export const OUTBOX_CHANNEL = 'outbox_events';
export const OUTBOX_BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 500;
const LISTEN_RETRY_MS = 5_000;

const JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Completed jobs are kept for a day so a re-published event with the same job ID is
  // recognised as a duplicate; processors are idempotent regardless.
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface OutboxRow {
  id: bigint;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Publishes committed outbox rows to BullMQ (ADR-0006). Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so several worker processes can relay in parallel without
 * publishing the same row twice concurrently. Job IDs are derived from the row ID, so a row
 * published again after a crash collapses into the existing job. Delivery is at-least-once.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly queues: ReadonlyMap<string, Queue>;
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;
  private listener: Client | undefined;
  private lastListenAttempt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUES.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUES.INDEXING) indexing: Queue,
  ) {
    this.queues = new Map([
      [QUEUES.NOTIFICATIONS, notifications],
      [QUEUES.INDEXING, indexing],
    ]);
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
    await this.listener?.end().catch(() => undefined);
  }

  /** Publishes one batch. Returns how many rows were claimed. */
  async drain(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, event_type, payload
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;

      // If Redis is down this throws, the transaction rolls back and the rows stay pending.
      await this.publish(rows);

      const ids = rows.map((row) => row.id);
      await tx.$executeRaw`UPDATE outbox_events SET published_at = now() WHERE id = ANY(${ids}::bigint[])`;
      return rows.length;
    });
  }

  /** Enqueues the jobs for these rows on every queue their event type routes to. */
  async publish(rows: OutboxRow[]): Promise<void> {
    const jobs = new Map<Queue, Parameters<Queue['addBulk']>[0]>();
    for (const row of rows) {
      if (!isDomainEventType(row.event_type)) {
        // Nothing consumes it; publishing is a no-op rather than a row that blocks forever.
        this.logger.warn({ outboxId: String(row.id), type: row.event_type }, 'Unrouted event');
        continue;
      }
      for (const name of EVENT_ROUTES[row.event_type]) {
        const queue = this.queues.get(name);
        if (!queue) throw new Error(`No queue registered for ${name}`);
        const list = jobs.get(queue) ?? [];
        const dedupe = EVENT_DEDUPLICATION[row.event_type] as
          ((payload: unknown) => string) | undefined;
        list.push({
          name: row.event_type,
          data: { ...row.payload, outboxId: String(row.id) },
          opts: {
            ...JOB_OPTIONS,
            jobId: `outbox-${String(row.id)}`,
            ...(dedupe
              ? { deduplication: { id: dedupe(row.payload), keepLastIfActive: true } }
              : {}),
          },
        });
        jobs.set(queue, list);
      }
    }
    for (const [queue, list] of jobs) await queue.addBulk(list);
  }

  /** Published rows are only an audit trail of delivery; keep a week (ADR-0006). */
  async prune(olderThanDays = 7): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM outbox_events
      WHERE published_at < now() - make_interval(days => ${olderThanDays}::int)`;
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.ensureListening();
      let claimed = 0;
      try {
        claimed = await this.drain();
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox relay failed; retrying');
      }
      // A full batch means there is probably more waiting: go again immediately.
      if (claimed < OUTBOX_BATCH_SIZE) await this.sleep(POLL_INTERVAL_MS);
    }
  }

  /** Waits for the poll interval, or less when a NOTIFY arrives. */
  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }

  /** LISTEN is an optimisation: without it the poll still publishes, just less promptly. */
  private async ensureListening(): Promise<void> {
    if (this.listener || Date.now() - this.lastListenAttempt < LISTEN_RETRY_MS) return;
    this.lastListenAttempt = Date.now();
    const client = new Client({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      connectionTimeoutMillis: 5_000,
    });
    client.on('notification', () => this.wakeUp?.());
    client.on('error', (error) => {
      this.logger.warn({ err: error }, 'Outbox LISTEN connection lost; polling until it returns');
      if (this.listener === client) this.listener = undefined;
      void client.end().catch(() => undefined);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
      this.listener = client;
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not LISTEN for outbox events; polling only');
      await client.end().catch(() => undefined);
    }
  }
}
