import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { observedQueues } from './metrics';

/**
 * Reports queue depth from the worker only (the API would report the same numbers twice).
 * Reuses the queues the processor modules registered instead of opening new connections.
 */
@Injectable()
export class QueueDepthCollector implements OnModuleInit, OnModuleDestroy {
  private readonly queues: Queue[] = [];

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    for (const name of Object.values(QUEUES)) {
      try {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        this.queues.push(queue);
        observedQueues.add(queue);
      } catch {
        // Not registered in this process.
      }
    }
  }

  onModuleDestroy(): void {
    for (const queue of this.queues) observedQueues.delete(queue);
  }
}
