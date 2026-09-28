import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TooManyRequestsException } from '../common/errors/too-many-requests.exception';
import type { Env } from '../config/env';
import type { AiFeature } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import type { WireUsage } from './ai.wire';

export interface UsageRecord {
  feature: AiFeature;
  userId: string;
  projectId: string;
  model: string;
  promptVersion?: string;
  usage: WireUsage;
  latencyMs: number;
  success: boolean;
}

const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Cost tracking and the per-person daily token budget (NFR-12). Every model call is recorded,
 * failed ones included, so the dashboard and the budget see what was actually spent.
 */
@Injectable()
export class AiUsageService {
  private readonly dailyBudget: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.dailyBudget = config.get('AI_DAILY_TOKEN_BUDGET', { infer: true });
  }

  async record(entry: UsageRecord): Promise<void> {
    await this.prisma.aiUsage.create({
      data: {
        feature: entry.feature,
        userId: entry.userId,
        projectId: entry.projectId,
        model: entry.model.slice(0, 100),
        promptVersion: entry.promptVersion?.slice(0, 50) ?? null,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        latencyMs: entry.latencyMs,
        costUsd: entry.usage.costUsd,
        success: entry.success,
      },
    });
  }

  async budget(userId: string): Promise<{ used: number; limit: number }> {
    const { _sum } = await this.prisma.aiUsage.aggregate({
      where: { userId, createdAt: { gte: startOfUtcDay() } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return {
      used: (_sum.inputTokens ?? 0) + (_sum.outputTokens ?? 0),
      limit: this.dailyBudget,
    };
  }

  /** Refuses new AI work once today's tokens reach the budget; it resets at 00:00 UTC. */
  async assertWithinBudget(userId: string): Promise<void> {
    const { used, limit } = await this.budget(userId);
    if (used < limit) return;
    const tomorrow = startOfUtcDay().getTime() + 86_400_000;
    throw new TooManyRequestsException(
      Math.ceil((tomorrow - Date.now()) / 1000),
      "You have used today's AI allowance. It resets at 00:00 UTC.",
    );
  }
}
