import { findIssueKeys } from '@forge/types';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';

type Tx = Prisma.TransactionClient;

/**
 * Links PRs and commits to the Forge issues they mention (FR-6.4). A key only resolves within
 * projects the repository is linked to: a PR in a repository nobody linked to project OPS can
 * never attach itself to OPS-3, whatever it says.
 *
 * Links are derived data. A PR's links always equal the mentions in its current title, body
 * and branch name (edit the title and a link can disappear); a commit's message never
 * changes, so its links are only ever added.
 */
@Injectable()
export class IssueLinker {
  constructor(private readonly prisma: PrismaService) {}

  /** Makes the PR's links match its mentions. Returns the IDs of issues newly linked. */
  async linkPullRequest(
    tx: Tx,
    pr: { id: string; repositoryId: string; title: string; body: string | null; headRef: string },
  ): Promise<string[]> {
    const text = `${pr.title}\n${pr.body ?? ''}\n${pr.headRef}`;
    const issueIds = await this.resolve(tx, pr.repositoryId, findIssueKeys(text));
    const existing = await tx.issueLink.findMany({
      where: { pullRequestId: pr.id },
      select: { issueId: true },
    });
    const current = new Set(existing.map((l) => l.issueId));

    await tx.issueLink.deleteMany({
      where: { pullRequestId: pr.id, issueId: { notIn: issueIds } },
    });
    const added = issueIds.filter((id) => !current.has(id));
    if (added.length > 0) {
      await tx.issueLink.createMany({
        data: added.map((issueId) => ({ issueId, linkType: 'PULL_REQUEST', pullRequestId: pr.id })),
        skipDuplicates: true,
      });
    }
    return added;
  }

  async linkCommit(
    tx: Tx,
    commit: { id: string; repositoryId: string; message: string },
  ): Promise<void> {
    const issueIds = await this.resolve(tx, commit.repositoryId, findIssueKeys(commit.message));
    if (issueIds.length === 0) return;
    await tx.issueLink.createMany({
      data: issueIds.map((issueId) => ({ issueId, linkType: 'COMMIT', commitId: commit.id })),
      skipDuplicates: true,
    });
  }

  /**
   * Re-derives every link for a repository's stored PRs and commits, e.g. after it is linked to
   * another project. Works in batches so a large history never holds one long transaction.
   */
  async relinkRepository(repositoryId: string, batchSize = 200): Promise<void> {
    for (let cursor: string | undefined; ;) {
      const prs = await this.prisma.githubPullRequest.findMany({
        where: { repositoryId },
        select: { id: true, repositoryId: true, title: true, body: true, headRef: true },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (prs.length === 0) break;
      await this.prisma.$transaction(async (tx) => {
        for (const pr of prs) await this.linkPullRequest(tx, pr);
      });
      cursor = prs.at(-1)?.id;
    }
    for (let cursor: string | undefined; ;) {
      const commits = await this.prisma.githubCommit.findMany({
        where: { repositoryId },
        select: { id: true, repositoryId: true, message: true },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (commits.length === 0) break;
      await this.prisma.$transaction(async (tx) => {
        for (const commit of commits) await this.linkCommit(tx, commit);
      });
      cursor = commits.at(-1)?.id;
    }
  }

  /** Issue IDs for keys like "PAY-12", limited to live issues in the repository's projects. */
  private async resolve(tx: Tx, repositoryId: string, keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const wanted = keys.map((key) => {
      const dash = key.lastIndexOf('-');
      return { key: key.slice(0, dash), number: Number(key.slice(dash + 1)) };
    });
    const issues = await tx.issue.findMany({
      where: {
        deletedAt: null,
        project: { repositories: { some: { repositoryId } } },
        OR: wanted.map((w) => ({ number: w.number, project: { key: w.key } })),
      },
      select: { id: true },
    });
    return issues.map((i) => i.id);
  }
}
