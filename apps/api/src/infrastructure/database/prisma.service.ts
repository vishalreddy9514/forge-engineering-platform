import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import type { Env } from '../../config/env';
import { PrismaClient } from '../../generated/prisma/client';
import { observedPools } from '../../observability/metrics';

/**
 * The application's single Prisma client. Prisma 7 talks to Postgres through the `pg` driver
 * adapter, so pool sizing is ordinary node-postgres configuration.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** Owned here (not by the adapter) so its saturation is visible: forge_db_pool_connections. */
  private readonly pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    const pool = new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: config.get('DATABASE_POOL_MAX', { infer: true }),
      // Fail fast rather than queue forever when the database is unreachable.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    super({
      adapter: new PrismaPg(pool),
      // Wait for a connection as long as the pool itself does (connectionTimeoutMillis), not
      // Prisma's 2 s default: under load a transaction would fail while the pool could still
      // serve it.
      transactionOptions: { maxWait: 5_000 },
    });
    this.pool = pool;
    observedPools.add(pool);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    observedPools.delete(this.pool);
    await this.$disconnect();
    await this.pool.end();
  }
}
