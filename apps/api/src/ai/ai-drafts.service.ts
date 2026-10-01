import type { DraftRequest } from '@forge/types';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { DraftError, DraftResult } from './ai.wire';
import { readSse, sseFrame } from './sse';

/**
 * FR-7.1, streamed (architecture §5.3): the model's output is relayed to the browser as it is
 * written, then one validated `result` (or `error`). The draft is only a suggestion: nothing is
 * created here, the user edits it and saves through the normal issue endpoint.
 */
@Injectable()
export class AiDraftsService {
  private readonly logger = new Logger(AiDraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
  ) {}

  /** Checks and upstream errors are thrown before any byte is sent, so they stay JSON errors. */
  async stream(projectId: string, userId: string, body: DraftRequest, res: Response) {
    await this.usage.assertWithinBudget(userId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        key: true,
        name: true,
        labels: { select: { name: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    // If the browser goes away, stop paying for tokens nobody will read.
    const abort = new AbortController();
    res.on('close', () => {
      abort.abort();
    });
    const started = Date.now();
    const upstream = await this.client.draftStream(
      {
        text: body.text,
        projectKey: project.key,
        projectName: project.name,
        labels: project.labels.map((l) => l.name),
      },
      abort.signal,
    );

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let finished = false;
    try {
      for await (const event of readSse(upstream)) {
        if (event.event === 'delta') {
          res.write(sseFrame('delta', JSON.parse(event.data) as unknown));
        } else if (event.event === 'result') {
          const result = DraftResult.parse(JSON.parse(event.data));
          await this.record(projectId, userId, result, started, true);
          res.write(
            sseFrame('result', { draft: result.draft, droppedLabels: result.droppedLabels }),
          );
          finished = true;
        } else if (event.event === 'error') {
          const error = DraftError.parse(JSON.parse(event.data));
          await this.record(projectId, userId, error, started, false);
          res.write(sseFrame('error', { code: error.code, message: messageFor(error.code) }));
          finished = true;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.logger.warn(`Draft stream failed: ${String(error)}`);
    }
    if (!finished && !abort.signal.aborted) {
      res.write(sseFrame('error', { code: 'interrupted', message: messageFor('interrupted') }));
    }
    res.end();
  }

  private record(
    projectId: string,
    userId: string,
    outcome: DraftResult | DraftError,
    started: number,
    success: boolean,
  ) {
    return this.usage.record({
      feature: 'ISSUE_DRAFT',
      userId,
      projectId,
      model: outcome.model,
      promptVersion: 'promptVersion' in outcome ? outcome.promptVersion : undefined,
      usage: outcome.usage,
      latencyMs: Date.now() - started,
      success,
    });
  }
}

/** User-facing text: the AI service's own messages can name providers and internals. */
function messageFor(code: string): string {
  switch (code) {
    case 'provider_unavailable':
      return 'The AI provider is busy or unreachable. Please try again in a minute.';
    case 'invalid_output':
      return 'The AI could not produce a usable draft for this text. Try rephrasing it.';
    case 'interrupted':
      return 'The draft was interrupted. Please try again.';
    default:
      return 'The draft could not be generated. Please try again.';
  }
}
