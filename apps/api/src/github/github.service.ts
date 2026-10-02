import type {
  Commit,
  GithubInstallation,
  GithubIssue,
  GithubRepository,
  GithubStatus,
  IssueDevelopment,
  LinkedRepository,
  ListCommitsQuery,
  ListGithubIssuesQuery,
  ListPullRequestsQuery,
  PullRequest,
  PullRequestDetail,
  SyncRequested,
  CursorPage,
} from '@forge/types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { decodeCursorParts, encodeCursorParts } from '../common/http/cursor';
import type { RequestMeta } from '../common/http/request-meta';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { GithubSync } from './github-sync.service';
import { GithubClient } from './github.client';
import { GithubApiError } from './github.errors';
import { GithubJobs } from './github.jobs';
import { Installation } from './github.payloads';
import { GithubSettings } from './github.settings';

const repoSelect = {
  id: true,
  fullName: true,
  htmlUrl: true,
  isPrivate: true,
  defaultBranch: true,
} satisfies Prisma.GithubRepositorySelect;

const linkIssueSelect = {
  issue: {
    select: { number: true, projectId: true, deletedAt: true, project: { select: { key: true } } },
  },
} satisfies Prisma.IssueLinkSelect;

type LinkRows = Prisma.IssueLinkGetPayload<{ select: typeof linkIssueSelect }>[];

/**
 * GitHub integration endpoints (FR-6): connecting installations, linking repositories to
 * projects, and reading the synced PRs, commits and issues. Everything here reads Forge's own
 * copy; only connecting an installation calls GitHub, to confirm it exists.
 */
@Injectable()
export class GithubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GithubSettings,
    private readonly client: GithubClient,
    private readonly sync: GithubSync,
    private readonly jobs: GithubJobs,
    private readonly audit: AuditService,
  ) {}

  status(): GithubStatus {
    return { configured: this.settings.app !== null, installUrl: this.settings.installUrl() };
  }

  // ───────────── Installations (administrators) ─────────────

  async listInstallations(): Promise<GithubInstallation[]> {
    const rows = await this.prisma.githubInstallation.findMany({
      orderBy: { accountLogin: 'asc' },
      include: { repositories: { select: repoSelect, orderBy: { fullName: 'asc' } } },
    });
    return rows.map((row) => ({
      id: row.id,
      installationId: Number(row.installationId),
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      suspended: row.suspendedAt !== null,
      createdAt: row.createdAt.toISOString(),
      repositories: row.repositories,
    }));
  }

  /**
   * Records an installation after GitHub redirects back from the install page. The ID comes
   * from the browser, so it is confirmed with GitHub (as the App) first: an ID that is not an
   * installation of this App is a 404, never stored.
   */
  async claimInstallation(
    installationId: number,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<GithubInstallation> {
    this.settings.require();
    let installation: Installation;
    try {
      installation = Installation.parse(
        await this.client.appRequest(`/app/installations/${String(installationId)}`),
      );
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) {
        throw new NotFoundException('No installation of this GitHub App has that ID');
      }
      throw error;
    }
    const row = await this.sync.upsertInstallation(installation, actor.id);
    await this.jobs.syncInstallation(installationId);
    await this.audit.record(
      {
        action: 'github.installation.connected',
        actorId: actor.id,
        entityType: 'github_installation',
        entityId: row.id,
        metadata: { installationId, account: installation.account.login },
      },
      meta,
    );
    const [result] = (await this.listInstallations()).filter((i) => i.id === row.id);
    if (!result) throw new NotFoundException('Installation not found');
    return result;
  }

  // ───────────── Project repositories ─────────────

  /** Repositories from active installations that this project has not linked yet. */
  async availableRepositories(projectId: string): Promise<GithubRepository[]> {
    return this.prisma.githubRepository.findMany({
      where: {
        installation: { suspendedAt: null },
        projects: { none: { projectId } },
      },
      select: repoSelect,
      orderBy: { fullName: 'asc' },
    });
  }

  async linkedRepositories(projectId: string): Promise<LinkedRepository[]> {
    const links = await this.prisma.projectRepository.findMany({
      where: { projectId },
      orderBy: { repository: { fullName: 'asc' } },
      select: {
        linkedAt: true,
        repository: {
          select: {
            ...repoSelect,
            syncStatus: true,
            lastSyncedAt: true,
            lastSyncError: true,
            contributors: {
              select: { login: true, avatarUrl: true, contributions: true },
              orderBy: [{ contributions: 'desc' }, { login: 'asc' }],
              take: 5,
            },
            _count: { select: { commits: true } },
          },
        },
      },
    });
    const ids = links.map((l) => l.repository.id);
    const [openPrs, openIssues] = await Promise.all([
      this.prisma.githubPullRequest.groupBy({
        by: ['repositoryId'],
        where: { repositoryId: { in: ids }, state: 'OPEN' },
        _count: { _all: true },
      }),
      this.prisma.githubIssue.groupBy({
        by: ['repositoryId'],
        where: { repositoryId: { in: ids }, state: 'OPEN' },
        _count: { _all: true },
      }),
    ]);
    const count = (rows: { repositoryId: string; _count: { _all: number } }[], id: string) =>
      rows.find((r) => r.repositoryId === id)?._count._all ?? 0;

    return links.map(({ linkedAt, repository: r }) => ({
      id: r.id,
      fullName: r.fullName,
      htmlUrl: r.htmlUrl,
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranch,
      linkedAt: linkedAt.toISOString(),
      syncStatus: r.syncStatus,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      lastSyncError: r.lastSyncError,
      counts: {
        openPullRequests: count(openPrs, r.id),
        commits: r._count.commits,
        openIssues: count(openIssues, r.id),
      },
      contributors: r.contributors,
    }));
  }

  /** Links a repository and queues a sync that also links its already-stored history. */
  async linkRepository(
    projectId: string,
    repositoryId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<LinkedRepository> {
    const repo = await this.prisma.githubRepository.findFirst({
      where: { id: repositoryId, installation: { suspendedAt: null } },
      select: { id: true, fullName: true },
    });
    if (!repo) throw new NotFoundException('Repository not found');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.projectRepository.create({ data: { projectId, repositoryId } });
        await tx.githubRepository.update({
          where: { id: repositoryId },
          data: { syncStatus: 'QUEUED', lastSyncError: null },
        });
        await this.audit.record(
          {
            action: 'github.repository.linked',
            actorId: actor.id,
            entityType: 'project',
            entityId: projectId,
            metadata: { repository: repo.fullName },
          },
          meta,
          tx,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('This repository is already linked to the project');
      }
      throw error;
    }
    await this.jobs.syncRepository(repositoryId, { relink: true });
    const linked = (await this.linkedRepositories(projectId)).find((r) => r.id === repositoryId);
    if (!linked) throw new NotFoundException('Repository not found');
    return linked;
  }

  /**
   * Unlinks a repository. Links from this project's issues to its PRs and commits go with it;
   * the synced data stays while another project still links the repository.
   */
  async unlinkRepository(
    projectId: string,
    repositoryId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.projectRepository.deleteMany({
        where: { projectId, repositoryId },
      });
      if (count === 0) throw new NotFoundException('This repository is not linked to the project');
      await tx.issueLink.deleteMany({
        where: {
          issue: { projectId },
          OR: [{ pullRequest: { repositoryId } }, { commit: { repositoryId } }],
        },
      });
      await this.audit.record(
        {
          action: 'github.repository.unlinked',
          actorId: actor.id,
          entityType: 'project',
          entityId: projectId,
          metadata: { repositoryId },
        },
        meta,
        tx,
      );
    });
    // Removes this project's copies of the repository's pull requests and commits from search.
    await this.sync.queueIndexing(repositoryId);
  }

  async requestSync(projectId: string, repositoryId: string): Promise<SyncRequested> {
    this.settings.require();
    await this.requireLinked(projectId, repositoryId);
    await this.sync.setStatus(repositoryId, 'QUEUED', null);
    await this.jobs.syncRepository(repositoryId);
    return { repositoryId, syncStatus: 'QUEUED' };
  }

  // ───────────── Synced data ─────────────

  async listPullRequests(
    projectId: string,
    query: ListPullRequestsQuery,
  ): Promise<CursorPage<PullRequest>> {
    const repositoryIds = await this.repositoryScope(projectId, query.repositoryId);
    const after = query.cursor ? decodeCursorParts(query.cursor, 2) : null;
    const rows = await this.prisma.githubPullRequest.findMany({
      where: {
        repositoryId: { in: repositoryIds },
        ...(query.state ? { state: query.state } : {}),
        ...(after ? keysetBefore('openedAt', after) : {}),
      },
      include: {
        repository: { select: { id: true, fullName: true } },
        issueLinks: { select: linkIssueSelect },
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return page(
      rows,
      query.limit,
      (r) => [r.openedAt.toISOString(), r.id],
      (r) => toPullRequest(r, projectId),
    );
  }

  /** One pull request of a repository linked to the project, with its description. */
  async pullRequest(projectId: string, pullRequestId: string): Promise<PullRequestDetail> {
    const row = await this.prisma.githubPullRequest.findFirst({
      where: { id: pullRequestId, repository: { projects: { some: { projectId } } } },
      include: {
        repository: { select: { id: true, fullName: true } },
        issueLinks: { select: linkIssueSelect },
      },
    });
    if (!row) throw new NotFoundException('Pull request not found');
    return {
      ...toPullRequest(row, projectId),
      body: row.body,
      headSha: row.headSha,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
    };
  }

  async listCommits(projectId: string, query: ListCommitsQuery): Promise<CursorPage<Commit>> {
    const repositoryIds = await this.repositoryScope(projectId, query.repositoryId);
    const after = query.cursor ? decodeCursorParts(query.cursor, 2) : null;
    const rows = await this.prisma.githubCommit.findMany({
      where: {
        repositoryId: { in: repositoryIds },
        ...(after ? keysetBefore('committedAt', after) : {}),
      },
      include: {
        repository: { select: { id: true, fullName: true } },
        issueLinks: { select: linkIssueSelect },
      },
      orderBy: [{ committedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return page(
      rows,
      query.limit,
      (r) => [r.committedAt.toISOString(), r.id],
      (r) => toCommit(r, projectId),
    );
  }

  async listIssues(
    projectId: string,
    query: ListGithubIssuesQuery,
  ): Promise<CursorPage<GithubIssue>> {
    const repositoryIds = await this.repositoryScope(projectId, query.repositoryId);
    const after = query.cursor ? decodeCursorParts(query.cursor, 2) : null;
    const rows = await this.prisma.githubIssue.findMany({
      where: {
        repositoryId: { in: repositoryIds },
        ...(query.state ? { state: query.state } : {}),
        ...(after ? keysetBefore('openedAt', after) : {}),
      },
      include: { repository: { select: { id: true, fullName: true } } },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return page(
      rows,
      query.limit,
      (r) => [r.openedAt.toISOString(), r.id],
      (r) => ({
        id: r.id,
        repository: r.repository,
        number: r.number,
        title: r.title,
        state: r.state,
        authorLogin: r.authorLogin,
        labels: r.labels,
        commentsCount: r.commentsCount,
        htmlUrl: r.htmlUrl,
        openedAt: r.openedAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
      }),
    );
  }

  /** PRs and commits that mention the issue, from repositories its project still links. */
  async development(issueId: string): Promise<IssueDevelopment> {
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deletedAt: null },
      select: { projectId: true },
    });
    if (!issue) throw new NotFoundException('Issue not found');
    const linked = { projects: { some: { projectId: issue.projectId } } };
    const [pullRequests, commits] = await Promise.all([
      this.prisma.githubPullRequest.findMany({
        where: { issueLinks: { some: { issueId } }, repository: linked },
        include: {
          repository: { select: { id: true, fullName: true } },
          issueLinks: { select: linkIssueSelect },
        },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.prisma.githubCommit.findMany({
        where: { issueLinks: { some: { issueId } }, repository: linked },
        include: {
          repository: { select: { id: true, fullName: true } },
          issueLinks: { select: linkIssueSelect },
        },
        orderBy: [{ committedAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);
    return {
      pullRequests: pullRequests.map((r) => toPullRequest(r, issue.projectId)),
      commits: commits.map((r) => toCommit(r, issue.projectId)),
    };
  }

  /** The project's linked repositories, optionally narrowed to one (404 if not linked). */
  private async repositoryScope(projectId: string, repositoryId?: string): Promise<string[]> {
    if (repositoryId) {
      await this.requireLinked(projectId, repositoryId);
      return [repositoryId];
    }
    const links = await this.prisma.projectRepository.findMany({
      where: { projectId },
      select: { repositoryId: true },
    });
    return links.map((l) => l.repositoryId);
  }

  private async requireLinked(projectId: string, repositoryId: string): Promise<void> {
    const link = await this.prisma.projectRepository.findUnique({
      where: { projectId_repositoryId: { projectId, repositoryId } },
      select: { projectId: true },
    });
    if (!link) throw new NotFoundException('This repository is not linked to the project');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows strictly after the cursor in (timestamp desc, id desc) order. */
function keysetBefore(field: string, [iso, id]: string[]) {
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime()) || !id || !UUID.test(id)) {
    throw new BadRequestException('Invalid cursor');
  }
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: id } }] };
}

function page<Row, Item>(
  rows: Row[],
  limit: number,
  key: (row: Row) => string[],
  map: (row: Row) => Item,
): CursorPage<Item> {
  const more = rows.length > limit;
  const visible = more ? rows.slice(0, limit) : rows;
  const last = visible.at(-1);
  return {
    data: visible.map(map),
    nextCursor: more && last ? encodeCursorParts(...key(last)) : null,
  };
}

/** Keys of this project's live issues among the links: other projects' keys are not shown. */
function issueKeys(links: LinkRows, projectId: string): string[] {
  return links
    .filter((l) => l.issue.projectId === projectId && l.issue.deletedAt === null)
    .map((l) => `${l.issue.project.key}-${String(l.issue.number)}`)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function toPullRequest(
  r: Prisma.GithubPullRequestGetPayload<{
    include: {
      repository: { select: { id: true; fullName: true } };
      issueLinks: { select: typeof linkIssueSelect };
    };
  }>,
  projectId: string,
): PullRequest {
  return {
    id: r.id,
    repository: r.repository,
    number: r.number,
    title: r.title,
    state: r.state,
    isDraft: r.isDraft,
    authorLogin: r.authorLogin,
    headRef: r.headRef,
    baseRef: r.baseRef,
    htmlUrl: r.htmlUrl,
    openedAt: r.openedAt.toISOString(),
    mergedAt: r.mergedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    updatedAt: r.githubUpdatedAt.toISOString(),
    issueKeys: issueKeys(r.issueLinks, projectId),
  };
}

function toCommit(
  r: Prisma.GithubCommitGetPayload<{
    include: {
      repository: { select: { id: true; fullName: true } };
      issueLinks: { select: typeof linkIssueSelect };
    };
  }>,
  projectId: string,
): Commit {
  return {
    id: r.id,
    repository: r.repository,
    sha: r.sha,
    message: r.message,
    authorLogin: r.authorLogin,
    authorName: r.authorName,
    committedAt: r.committedAt.toISOString(),
    htmlUrl: r.htmlUrl,
    issueKeys: issueKeys(r.issueLinks, projectId),
  };
}
