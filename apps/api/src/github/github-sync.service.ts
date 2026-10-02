import { Injectable, Logger } from '@nestjs/common';

import { IndexingJobs } from '../search/indexing.jobs';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { writeOutbox } from '../outbox/outbox.writer';
import { GithubClient } from './github.client';
import { GithubApiError } from './github.errors';
import {
  Commit,
  Contributor,
  Installation,
  InstallationRepositories,
  Issue,
  parseItems,
  PullRequest,
  PushCommit,
  Repository,
} from './github.payloads';
import { GithubSettings } from './github.settings';
import { IssueLinker } from './issue-linker';

interface SyncTarget {
  id: string;
  fullName: string;
  lastSyncedAt: Date | null;
  installation: { installationId: bigint; suspendedAt: Date | null };
}

/** How far back an incremental sync overlaps the previous one, for clock skew between systems. */
const OVERLAP_MS = 5 * 60_000;

/**
 * Mirrors GitHub data into Forge (FR-6.3). Every write is idempotent, so a sync interrupted by
 * a rate limit or a crash is simply run again:
 *
 * - installations and their repository lists come from the App's installation endpoints;
 * - PRs and GitHub issues are upserted with an `updated_at` guard, so a slow full sync or an
 *   out-of-order webhook never overwrites newer data with older;
 * - commits are immutable and inserted once;
 * - issue links are re-derived for every PR and commit written (see IssueLinker).
 *
 * Only repositories linked to at least one project are synced beyond their metadata.
 */
@Injectable()
export class GithubSync {
  private readonly logger = new Logger(GithubSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClient,
    private readonly settings: GithubSettings,
    private readonly linker: IssueLinker,
    private readonly indexing: IndexingJobs,
  ) {}

  // ───────────── Installations ─────────────

  /**
   * Refreshes an installation and its repository list from GitHub. Repositories the
   * installation no longer grants are deleted, and with them their PRs, commits and links:
   * access was withdrawn on GitHub, so Forge stops showing the data.
   */
  async syncInstallation(installationId: number): Promise<{ repositories: number }> {
    let installation: Installation;
    try {
      installation = Installation.parse(
        await this.github.appRequest(`/app/installations/${String(installationId)}`),
      );
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) {
        // Uninstalled while the job waited.
        await this.removeInstallation(installationId);
        return { repositories: 0 };
      }
      throw error;
    }
    const row = await this.upsertInstallation(installation);
    if (installation.suspended_at) return { repositories: 0 };

    const seen: bigint[] = [];
    for await (const page of this.github.paginate(
      installationId,
      '/installation/repositories',
      {},
      {
        background: true,
        maxPages: this.settings.maxPages,
        items: (body) => InstallationRepositories.parse(body).repositories,
      },
    )) {
      for (const repo of page as Repository[]) {
        await this.upsertRepository(row.id, repo);
        seen.push(BigInt(repo.id));
      }
    }
    await this.prisma.githubRepository.deleteMany({
      where: { installationId: row.id, githubId: { notIn: seen } },
    });
    return { repositories: seen.length };
  }

  async upsertInstallation(installation: Installation, installedById?: string) {
    const data = {
      accountLogin: installation.account.login,
      accountType:
        installation.account.type === 'Organization'
          ? ('ORGANIZATION' as const)
          : ('USER' as const),
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    };
    return this.prisma.githubInstallation.upsert({
      where: { installationId: BigInt(installation.id) },
      create: { installationId: BigInt(installation.id), installedById, ...data },
      update: data,
    });
  }

  async removeInstallation(installationId: number): Promise<void> {
    await this.prisma.githubInstallation.deleteMany({
      where: { installationId: BigInt(installationId) },
    });
    await this.github.evictToken(installationId);
  }

  async setSuspended(installationId: number, suspended: boolean): Promise<void> {
    await this.prisma.githubInstallation.updateMany({
      where: { installationId: BigInt(installationId) },
      data: { suspendedAt: suspended ? new Date() : null },
    });
  }

  private upsertRepository(installationRowId: string, repo: Repository) {
    const data = {
      installationId: installationRowId,
      fullName: repo.full_name,
      isPrivate: repo.private,
      htmlUrl: repo.html_url,
      ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
    };
    return this.prisma.githubRepository.upsert({
      where: { githubId: BigInt(repo.id) },
      create: { githubId: BigInt(repo.id), defaultBranch: repo.default_branch ?? 'main', ...data },
      update: data,
    });
  }

  // ───────────── Repositories ─────────────

  /**
   * Full sync the first time, incremental afterwards (changes since the last successful sync,
   * with a small overlap). `relink` re-derives links for data already stored, used when the
   * repository is linked to another project.
   */
  async syncRepository(repositoryId: string, options: { relink?: boolean } = {}): Promise<void> {
    const repo = await this.prisma.githubRepository.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        fullName: true,
        lastSyncedAt: true,
        installation: { select: { installationId: true, suspendedAt: true } },
        _count: { select: { projects: true } },
      },
    });
    if (!repo) return; // removed from the installation since the job was queued
    if (repo._count.projects === 0) {
      await this.setStatus(repositoryId, 'IDLE', null);
      return;
    }
    if (repo.installation.suspendedAt) {
      await this.setStatus(repositoryId, 'FAILED', 'The GitHub App installation is suspended');
      return;
    }

    const startedAt = new Date();
    await this.setStatus(repositoryId, 'RUNNING', null);
    if (options.relink) await this.linker.relinkRepository(repositoryId);

    const target = await this.refreshMetadata(repo);
    const since = repo.lastSyncedAt
      ? new Date(repo.lastSyncedAt.getTime() - OVERLAP_MS)
      : undefined;
    await this.syncPullRequests(target, since);
    await this.syncCommits(target, since);
    await this.syncIssues(target, since);
    await this.syncContributors(target);

    await this.prisma.githubRepository.update({
      where: { id: repositoryId },
      data: { lastSyncedAt: startedAt, syncStatus: 'IDLE', lastSyncError: null },
    });
    // Pull requests and commits are searchable and citable (FR-8.1); unchanged ones are skipped.
    await this.indexing.repository(repositoryId);
  }

  /** Queues indexing of the repository's pull requests and commits for search (FR-8.1). */
  queueIndexing(repositoryId: string): Promise<void> {
    return this.indexing.repository(repositoryId);
  }

  async setStatus(
    repositoryId: string,
    syncStatus: 'IDLE' | 'QUEUED' | 'RUNNING' | 'FAILED' | 'RATE_LIMITED',
    lastSyncError: string | null,
  ): Promise<void> {
    await this.prisma.githubRepository.updateMany({
      where: { id: repositoryId },
      data: { syncStatus, lastSyncError: lastSyncError?.slice(0, 500) ?? null },
    });
  }

  /** Picks up renames and default-branch changes before listing anything. */
  private async refreshMetadata(
    repo: SyncTarget,
  ): Promise<SyncTarget & { installationId: number }> {
    const installationId = Number(repo.installation.installationId);
    const fresh = Repository.parse(
      await this.github.get(installationId, `/repos/${repo.fullName}`, {}, { background: true }),
    );
    await this.prisma.githubRepository.update({
      where: { id: repo.id },
      data: {
        fullName: fresh.full_name,
        isPrivate: fresh.private,
        htmlUrl: fresh.html_url,
        ...(fresh.default_branch ? { defaultBranch: fresh.default_branch } : {}),
      },
    });
    return { ...repo, fullName: fresh.full_name, installationId };
  }

  private async syncPullRequests(
    repo: SyncTarget & { installationId: number },
    since: Date | undefined,
  ): Promise<void> {
    // Newest updates first, so an incremental sync stops at the first PR older than `since`.
    const pages = this.github.paginate(
      repo.installationId,
      `/repos/${repo.fullName}/pulls`,
      { state: 'all', sort: 'updated', direction: 'desc' },
      { background: true, maxPages: this.settings.maxPages },
    );
    for await (const page of pages) {
      const { valid, invalid } = parseItems(PullRequest, page);
      this.warnInvalid('pull requests', invalid, repo.fullName);
      for (const pr of valid) {
        if (since && new Date(pr.updated_at) < since) return;
        await this.upsertPullRequest(repo.id, pr);
      }
    }
  }

  private async syncCommits(
    repo: SyncTarget & { installationId: number },
    since: Date | undefined,
  ): Promise<void> {
    const pages = this.github.paginate(
      repo.installationId,
      `/repos/${repo.fullName}/commits`,
      { since: since?.toISOString() },
      { background: true, maxPages: this.settings.maxPages },
    );
    for await (const page of pages) {
      const { valid, invalid } = parseItems(Commit, page);
      this.warnInvalid('commits', invalid, repo.fullName);
      await this.insertCommits(
        repo.id,
        valid.map((c) => ({
          sha: c.sha,
          message: c.commit.message,
          authorLogin: c.author?.login ?? null,
          authorName: c.commit.author?.name ?? null,
          committedAt: new Date(c.commit.author?.date ?? Date.now()),
          htmlUrl: c.html_url,
        })),
      );
    }
  }

  private async syncIssues(
    repo: SyncTarget & { installationId: number },
    since: Date | undefined,
  ): Promise<void> {
    const pages = this.github.paginate(
      repo.installationId,
      `/repos/${repo.fullName}/issues`,
      { state: 'all', sort: 'updated', direction: 'desc', since: since?.toISOString() },
      { background: true, maxPages: this.settings.maxPages },
    );
    for await (const page of pages) {
      const { valid, invalid } = parseItems(Issue, page);
      this.warnInvalid('issues', invalid, repo.fullName);
      // The issues endpoint lists pull requests too; those are synced from /pulls.
      for (const issue of valid.filter((i) => i.pull_request === undefined)) {
        await this.upsertIssue(repo.id, issue);
      }
    }
  }

  /** Top contributors (first page, up to 100), replaced as a set. */
  private async syncContributors(repo: SyncTarget & { installationId: number }): Promise<void> {
    const body = await this.github.get(
      repo.installationId,
      `/repos/${repo.fullName}/contributors`,
      { per_page: 100 },
      { background: true },
    );
    // An empty repository answers 204 with no body, which parses as an empty list upstream.
    const { valid } = parseItems(Contributor, Array.isArray(body) ? body : []);
    await this.prisma.$transaction([
      this.prisma.githubContributor.deleteMany({ where: { repositoryId: repo.id } }),
      this.prisma.githubContributor.createMany({
        data: valid.map((c) => ({
          repositoryId: repo.id,
          login: c.login,
          avatarUrl: c.avatar_url ?? null,
          contributions: c.contributions,
        })),
      }),
    ]);
  }

  // ───────────── Writes shared with webhooks ─────────────

  /**
   * Upserts a PR unless the stored copy is newer, then re-derives its links. With `notify`, a
   * newly linked open PR also writes a `pull_request.opened` event in the same transaction.
   * Returns whether anything was written.
   */
  async upsertPullRequest(
    repositoryId: string,
    pr: PullRequest,
    options: { notify?: boolean } = {},
  ): Promise<boolean> {
    const updatedAt = new Date(pr.updated_at);
    const data = {
      title: pr.title,
      body: pr.body,
      state: pr.merged_at
        ? ('MERGED' as const)
        : pr.state === 'open'
          ? ('OPEN' as const)
          : ('CLOSED' as const),
      isDraft: pr.draft ?? false,
      authorLogin: pr.user?.login ?? null,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      // Absent from list responses: keep what a webhook or earlier fetch stored.
      ...(pr.additions === undefined ? {} : { additions: pr.additions }),
      ...(pr.deletions === undefined ? {} : { deletions: pr.deletions }),
      ...(pr.changed_files === undefined ? {} : { changedFiles: pr.changed_files }),
      htmlUrl: pr.html_url,
      openedAt: new Date(pr.created_at),
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
      githubUpdatedAt: updatedAt,
      syncedAt: new Date(),
    };

    return this.prisma.$transaction(async (tx) => {
      const id = await this.guardedWrite(
        async () => {
          const [created] = await tx.githubPullRequest.createManyAndReturn({
            data: [{ repositoryId, githubId: BigInt(pr.id), number: pr.number, ...data }],
            skipDuplicates: true,
            select: { id: true },
          });
          return created ?? null;
        },
        async () => {
          const updated = await tx.githubPullRequest.updateManyAndReturn({
            where: { githubId: BigInt(pr.id), githubUpdatedAt: { lte: updatedAt } },
            data,
            select: { id: true },
          });
          return updated[0] ?? null;
        },
      );
      if (!id) return false; // stored copy is newer

      const added = await this.linker.linkPullRequest(tx, {
        id,
        repositoryId,
        title: pr.title,
        body: pr.body,
        headRef: pr.head.ref,
      });
      if (options.notify && data.state === 'OPEN' && added.length > 0) {
        await writeOutbox(
          tx,
          'pull_request.opened',
          { type: 'pull_request', id },
          { pullRequestId: id, issueIds: added },
        );
      }
      return true;
    });
  }

  async upsertIssue(repositoryId: string, issue: Issue): Promise<boolean> {
    const updatedAt = new Date(issue.updated_at);
    const data = {
      title: issue.title,
      state: issue.state === 'open' ? ('OPEN' as const) : ('CLOSED' as const),
      authorLogin: issue.user?.login ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      commentsCount: issue.comments,
      htmlUrl: issue.html_url,
      openedAt: new Date(issue.created_at),
      closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
      githubUpdatedAt: updatedAt,
      syncedAt: new Date(),
    };
    const id = await this.guardedWrite(
      async () => {
        const [created] = await this.prisma.githubIssue.createManyAndReturn({
          data: [{ repositoryId, githubId: BigInt(issue.id), number: issue.number, ...data }],
          skipDuplicates: true,
          select: { id: true },
        });
        return created ?? null;
      },
      async () => {
        const updated = await this.prisma.githubIssue.updateManyAndReturn({
          where: { githubId: BigInt(issue.id), githubUpdatedAt: { lte: updatedAt } },
          data,
          select: { id: true },
        });
        return updated[0] ?? null;
      },
    );
    return id !== null;
  }

  async deleteIssue(githubId: number): Promise<void> {
    await this.prisma.githubIssue.deleteMany({ where: { githubId: BigInt(githubId) } });
  }

  /** Inserts commits not seen before and links the new ones. */
  async insertCommits(
    repositoryId: string,
    commits: {
      sha: string;
      message: string;
      authorLogin: string | null;
      authorName: string | null;
      committedAt: Date;
      htmlUrl: string;
    }[],
  ): Promise<number> {
    if (commits.length === 0) return 0;
    const created = await this.prisma.githubCommit.createManyAndReturn({
      data: commits.map((c) => ({
        repositoryId,
        ...c,
        authorName: c.authorName?.slice(0, 200) ?? null,
      })),
      skipDuplicates: true,
      select: { id: true, repositoryId: true, message: true },
    });
    if (created.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const commit of created) await this.linker.linkCommit(tx, commit);
      });
    }
    return created.length;
  }

  pushCommits(repositoryId: string, commits: PushCommit[]): Promise<number> {
    return this.insertCommits(
      repositoryId,
      commits.map((c) => ({
        sha: c.id,
        message: c.message,
        authorLogin: c.author.username ?? null,
        authorName: c.author.name ?? null,
        committedAt: new Date(c.timestamp),
        htmlUrl: c.url,
      })),
    );
  }

  /**
   * Conditional update, else insert, else (a concurrent insert won) the conditional update once
   * more. Inserts use ON CONFLICT DO NOTHING, so a race never raises an error that would abort
   * the surrounding transaction. Returns null when the stored copy is newer.
   */
  private async guardedWrite(
    insert: () => Promise<{ id: string } | null>,
    update: () => Promise<{ id: string } | null>,
  ): Promise<string | null> {
    const row = (await update()) ?? (await insert()) ?? (await update());
    return row?.id ?? null;
  }

  private warnInvalid(what: string, invalid: number, repo: string): void {
    if (invalid > 0) this.logger.warn(`Skipped ${String(invalid)} malformed ${what} from ${repo}`);
  }
}
