import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { GithubSync } from './github-sync.service';
import { GithubJobs } from './github.jobs';
import {
  InstallationEvent,
  IssuesEvent,
  PullRequestEvent,
  PushEvent,
  Repository,
} from './github.payloads';

const InstallationRef = z.object({ installation: z.object({ id: z.number().int() }) });
const RepositoryEvent = z.object({ action: z.string(), repository: Repository });

/**
 * Applies one stored webhook delivery (ADR-0008). Handlers use only the payload, never the
 * GitHub API, so webhooks cost no rate limit; anything that needs a fetch (a new installation's
 * repositories) is handed to a sync job. Deliveries for repositories no project has linked are
 * acknowledged and ignored.
 */
@Injectable()
export class GithubWebhookHandler {
  private readonly logger = new Logger(GithubWebhookHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GithubSync,
    private readonly jobs: GithubJobs,
  ) {}

  async process(deliveryId: string): Promise<string> {
    const delivery = await this.prisma.githubWebhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { event: true, payload: true, processedAt: true },
    });
    if (!delivery) return 'missing';
    if (delivery.processedAt) return 'already processed';

    let outcome: string;
    try {
      outcome = await this.apply(delivery.event, delivery.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.githubWebhookDelivery.update({
        where: { id: deliveryId },
        data: { error: message.slice(0, 500) },
      });
      // A payload that does not match GitHub's documented shape will not match on a retry.
      if (error instanceof z.ZodError)
        throw new UnrecoverableError(`Malformed payload: ${message}`);
      throw error;
    }
    await this.prisma.githubWebhookDelivery.update({
      where: { id: deliveryId },
      data: { processedAt: new Date(), error: null },
    });
    return outcome;
  }

  private async apply(event: string, payload: unknown): Promise<string> {
    switch (event) {
      case 'ping':
        return 'pong';
      case 'installation':
        return this.installation(InstallationEvent.parse(payload));
      case 'installation_repositories':
        await this.jobs.syncInstallation(InstallationRef.parse(payload).installation.id);
        return 'installation sync queued';
      case 'repository':
        return this.repository(RepositoryEvent.parse(payload));
      case 'pull_request':
        return this.pullRequest(PullRequestEvent.parse(payload));
      case 'push':
        return this.push(PushEvent.parse(payload));
      case 'issues':
        return this.issues(IssuesEvent.parse(payload));
      default:
        return `ignored ${event}`;
    }
  }

  private async installation(event: z.infer<typeof InstallationEvent>): Promise<string> {
    const { id } = event.installation;
    switch (event.action) {
      case 'deleted':
        await this.sync.removeInstallation(id);
        return 'installation removed';
      case 'suspend':
        await this.sync.setSuspended(id, true);
        return 'installation suspended';
      default:
        // created, unsuspend, new_permissions_accepted: record it and fetch its repositories.
        await this.sync.upsertInstallation(event.installation);
        await this.jobs.syncInstallation(id);
        return 'installation sync queued';
    }
  }

  private async repository(event: z.infer<typeof RepositoryEvent>): Promise<string> {
    const githubId = BigInt(event.repository.id);
    if (event.action === 'deleted') {
      await this.prisma.githubRepository.deleteMany({ where: { githubId } });
      return 'repository removed';
    }
    // renamed, transferred, privatized, publicized, edited (default branch)
    const { count } = await this.prisma.githubRepository.updateMany({
      where: { githubId },
      data: {
        fullName: event.repository.full_name,
        isPrivate: event.repository.private,
        htmlUrl: event.repository.html_url,
        ...(event.repository.default_branch
          ? { defaultBranch: event.repository.default_branch }
          : {}),
      },
    });
    return count > 0 ? 'repository updated' : 'unknown repository';
  }

  private async pullRequest(event: z.infer<typeof PullRequestEvent>): Promise<string> {
    const repositoryId = await this.linkedRepository(event.repository);
    if (!repositoryId) return 'repository not linked';
    const written = await this.sync.upsertPullRequest(repositoryId, event.pull_request, {
      notify: event.action === 'opened',
    });
    if (!written) return 'stale pull request update ignored';
    await this.sync.queueIndexing(repositoryId);
    return `pull request ${event.action}`;
  }

  private async push(event: z.infer<typeof PushEvent>): Promise<string> {
    if (event.deleted) return 'branch deleted';
    const repositoryId = await this.linkedRepository(event.repository);
    if (!repositoryId) return 'repository not linked';
    const created = await this.sync.pushCommits(repositoryId, event.commits);
    if (created > 0) await this.sync.queueIndexing(repositoryId);
    return `${String(created)} new commits`;
  }

  private async issues(event: z.infer<typeof IssuesEvent>): Promise<string> {
    const repositoryId = await this.linkedRepository(event.repository);
    if (!repositoryId) return 'repository not linked';
    if (event.action === 'deleted') {
      await this.sync.deleteIssue(event.issue.id);
      return 'issue deleted';
    }
    const written = await this.sync.upsertIssue(repositoryId, event.issue);
    return written ? `issue ${event.action}` : 'stale issue update ignored';
  }

  /** The repository's ID when at least one project links it; keeps its name current too. */
  private async linkedRepository(repo: { id: number; full_name: string }): Promise<string | null> {
    const row = await this.prisma.githubRepository.findUnique({
      where: { githubId: BigInt(repo.id) },
      select: { id: true, fullName: true, _count: { select: { projects: true } } },
    });
    if (!row || row._count.projects === 0) return null;
    if (row.fullName !== repo.full_name) {
      await this.prisma.githubRepository.update({
        where: { id: row.id },
        data: { fullName: repo.full_name },
      });
    }
    return row.id;
  }
}
