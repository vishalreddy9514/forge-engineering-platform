import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/decorators';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { GithubJobs } from './github.jobs';
import { GithubSettings } from './github.settings';
import { isValidWebhookSignature } from './webhook-signature';

/** Path the raw-body parser is mounted on (app.setup.ts), relative to the API prefix. */
export const GITHUB_WEBHOOK_PATH = 'webhooks/github';

/** X-GitHub-Delivery is a GUID; anything else is not from GitHub. */
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z_]{1,64}$/;

/**
 * GitHub webhook receiver (ADR-0008). Authenticated by the HMAC signature over the raw body,
 * not by a user token. It does the minimum synchronously: verify, store the delivery (its ID
 * deduplicates GitHub's redeliveries), queue a job, answer 202. GitHub expects a response
 * within 10 seconds, and processing may take longer.
 */
@ApiExcludeController()
@Controller(GITHUB_WEBHOOK_PATH)
export class GithubWebhookController {
  constructor(
    private readonly settings: GithubSettings,
    private readonly prisma: PrismaService,
    private readonly jobs: GithubJobs,
  ) {}

  @Post()
  @Public()
  @HttpCode(202)
  // Generous: GitHub's deliveries come from a small set of addresses. This only blunts floods.
  @RateLimit({ name: 'github-webhook', limit: 600, windowSeconds: 60, by: 'ip' })
  async receive(
    @Req() req: Request,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    const app = this.settings.require();
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || !isValidWebhookSignature(app.webhookSecret, body, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !event || !EVENT_NAME.test(event)) {
      throw new BadRequestException('Missing or invalid X-GitHub-Event / X-GitHub-Delivery');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadRequestException('The payload is not JSON');
    }
    const fields = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      action?: unknown;
      installation?: { id?: unknown };
    };

    const { count } = await this.prisma.githubWebhookDelivery.createMany({
      data: [
        {
          id: deliveryId,
          event,
          action: typeof fields.action === 'string' ? fields.action.slice(0, 64) : null,
          installationId:
            typeof fields.installation?.id === 'number' ? BigInt(fields.installation.id) : null,
          payload: payload as object,
        },
      ],
      skipDuplicates: true,
    });
    const duplicate = count === 0;
    // Queue even for a duplicate that has not been processed: the first attempt may have
    // stored the delivery and then failed to reach Redis. The job ID makes this a no-op
    // when the job already exists.
    if (!duplicate || !(await this.isProcessed(deliveryId))) {
      await this.jobs.processWebhook(deliveryId);
    }
    return { received: true, duplicate };
  }

  private async isProcessed(deliveryId: string): Promise<boolean> {
    const row = await this.prisma.githubWebhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { processedAt: true },
    });
    return Boolean(row?.processedAt);
  }
}
