import type { DocumentSourceType } from '@forge/types';
import { Injectable, Logger } from '@nestjs/common';

import { AiUsageService } from '../ai/ai-usage.service';
import { AiClient } from '../ai/ai.client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { IndexingJobs, type IndexSourceJob } from './indexing.jobs';
import {
  contentHash,
  normaliseComment,
  normaliseCommit,
  normaliseIssue,
  normalisePullRequest,
  type NormalisedSource,
} from './source-normaliser';

export type IndexOutcome = 'indexed' | 'unchanged' | 'deleted' | 'pending' | 'missing';

const PAGE = 200;

interface CommitRow {
  id: string;
  sha: string;
  message: string;
  authorLogin: string | null;
  authorName: string | null;
  htmlUrl: string;
}

/**
 * Keeps `documents` in step with their sources (FR-8.1, FR-8.3). The API owns these rows (it
 * knows keys, titles and URLs); the AI service chunks and embeds them. Every operation reads the
 * source's current state, so it is safe to repeat and safe to run after the source is gone.
 */
@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
    private readonly jobs: IndexingJobs,
  ) {}

  async indexSource({ sourceType, sourceId, force = false }: IndexSourceJob): Promise<string> {
    switch (sourceType) {
      case 'ISSUE':
        return this.indexIssue(sourceId, force);
      case 'COMMENT':
        return this.indexComment(sourceId, force);
      case 'UPLOAD':
        return this.indexUpload(sourceId, force);
      case 'PULL_REQUEST':
      case 'COMMIT':
        // Repository jobs index these, once per linked project.
        throw new Error(`Index ${sourceType} through its repository`);
      default:
        throw new Error(`Unknown source type: ${String(sourceType)}`);
    }
  }

  private async indexIssue(issueId: string, force: boolean): Promise<string> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        projectId: true,
        number: true,
        title: true,
        description: true,
        type: true,
        priority: true,
        status: true,
        deletedAt: true,
        project: { select: { key: true } },
        assignee: { select: { displayName: true } },
        labels: { select: { label: { select: { name: true } } } },
        comments: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (!issue || issue.deletedAt) {
      // A deleted issue takes its comments out of search with it.
      const comments = await this.prisma.issueComment.findMany({
        where: { issueId },
        select: { id: true },
      });
      const { count } = await this.prisma.document.deleteMany({
        where: {
          OR: [
            { sourceType: 'ISSUE', sourceId: issueId },
            { sourceType: 'COMMENT', sourceId: { in: comments.map((c) => c.id) } },
          ],
        },
      });
      return `deleted ${String(count)} document(s)`;
    }

    const desired = normaliseIssue({
      ...issue,
      projectKey: issue.project.key,
      assignee: issue.assignee?.displayName ?? null,
      labels: issue.labels.map((l) => l.label.name),
    });
    const { outcome, previousTitles } = await this.sync('ISSUE', issue.id, [desired], force);
    // Comment text carries the issue's title for context; a renamed issue re-indexes them.
    if (previousTitles.length > 0 && !previousTitles.includes(desired.title)) {
      await this.jobs.sources(
        issue.comments.map((c) => ({ sourceType: 'COMMENT' as const, sourceId: c.id })),
      );
    }
    return outcome;
  }

  private async indexComment(commentId: string, force: boolean): Promise<string> {
    const comment = await this.prisma.issueComment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        body: true,
        deletedAt: true,
        author: { select: { displayName: true } },
        issue: {
          select: {
            projectId: true,
            number: true,
            title: true,
            deletedAt: true,
            project: { select: { key: true } },
          },
        },
      },
    });
    if (!comment || comment.deletedAt || comment.issue.deletedAt) {
      const { count } = await this.prisma.document.deleteMany({
        where: { sourceType: 'COMMENT', sourceId: commentId },
      });
      return `deleted ${String(count)} document(s)`;
    }
    const desired = normaliseComment({
      id: comment.id,
      body: comment.body,
      author: comment.author.displayName,
      issue: { ...comment.issue, projectKey: comment.issue.project.key },
    });
    return (await this.sync('COMMENT', comment.id, [desired], force)).outcome;
  }

  /** Uploads are their own source: the row was written by the upload; only embed it. */
  private async indexUpload(documentId: string, force: boolean): Promise<string> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, projectId: true, indexedAt: true, sourceType: true },
    });
    if (!document || document.sourceType !== 'UPLOAD') return 'missing';
    if (document.indexedAt && !force) return 'unchanged';
    return this.embed(document.id, document.projectId);
  }

  /** Every pull request and commit of a repository, once for each project linked to it. */
  async indexRepository(repositoryId: string, force = false): Promise<string> {
    const repo = await this.prisma.githubRepository.findUnique({
      where: { id: repositoryId },
      select: { fullName: true, projects: { select: { projectId: true } } },
    });
    if (!repo) return 'missing'; // its rows cascaded; the backfill removes their documents
    const projectIds = repo.projects.map((p) => p.projectId);
    let changed = 0;

    let cursor: string | undefined;
    for (;;) {
      const prs = await this.prisma.githubPullRequest.findMany({
        where: { repositoryId },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          number: true,
          title: true,
          body: true,
          state: true,
          isDraft: true,
          authorLogin: true,
          headRef: true,
          baseRef: true,
          htmlUrl: true,
        },
      });
      for (const pr of prs) {
        const source = { ...pr, repository: repo.fullName };
        const desired = projectIds.map((id) => normalisePullRequest(source, id));
        if ((await this.sync('PULL_REQUEST', pr.id, desired, force)).outcome !== 'unchanged') {
          changed += 1;
        }
      }
      if (prs.length < PAGE) break;
      cursor = prs.at(-1)?.id;
    }

    cursor = undefined;
    for (;;) {
      const commits: CommitRow[] = await this.prisma.githubCommit.findMany({
        where: { repositoryId },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          sha: true,
          message: true,
          authorLogin: true,
          authorName: true,
          htmlUrl: true,
        },
      });
      for (const commit of commits) {
        const source = { ...commit, repository: repo.fullName };
        const desired = projectIds.map((id) => normaliseCommit(source, id));
        if ((await this.sync('COMMIT', commit.id, desired, force)).outcome !== 'unchanged') {
          changed += 1;
        }
      }
      if (commits.length < PAGE) break;
      cursor = commits.at(-1)?.id;
    }
    return `${String(changed)} source(s) changed`;
  }

  /**
   * Repairs the index after anything that bypassed the normal path: an AI outage that outlasted
   * a job's retries, a repository removed from GitHub, data that predates indexing. With `all`,
   * every source is re-embedded (after changing the embedding model).
   */
  async backfill(all = false): Promise<Record<string, number>> {
    const removed = await this.prisma.$executeRaw`
      DELETE FROM documents d
      WHERE (d.source_type = 'ISSUE' AND NOT EXISTS (
               SELECT 1 FROM issues i WHERE i.id = d.source_id AND i.deleted_at IS NULL))
         OR (d.source_type = 'COMMENT' AND NOT EXISTS (
               SELECT 1 FROM issue_comments c JOIN issues i ON i.id = c.issue_id
               WHERE c.id = d.source_id AND c.deleted_at IS NULL AND i.deleted_at IS NULL))
         OR (d.source_type = 'PULL_REQUEST' AND NOT EXISTS (
               SELECT 1 FROM github_pull_requests p
               JOIN project_repositories pr ON pr.repository_id = p.repository_id
               WHERE p.id = d.source_id AND pr.project_id = d.project_id))
         OR (d.source_type = 'COMMIT' AND NOT EXISTS (
               SELECT 1 FROM github_commits c
               JOIN project_repositories pr ON pr.repository_id = c.repository_id
               WHERE c.id = d.source_id AND pr.project_id = d.project_id))`;

    const issues = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM issues i
      WHERE i.deleted_at IS NULL
        AND (${all} OR NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.source_type = 'ISSUE' AND d.source_id = i.id AND d.indexed_at IS NOT NULL))`;
    const comments = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM issue_comments c JOIN issues i ON i.id = c.issue_id
      WHERE c.deleted_at IS NULL AND i.deleted_at IS NULL
        AND (${all} OR NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.source_type = 'COMMENT' AND d.source_id = c.id AND d.indexed_at IS NOT NULL))`;
    const uploads = await this.prisma.document.findMany({
      where: { sourceType: 'UPLOAD', ...(all ? {} : { indexedAt: null }) },
      select: { id: true },
    });
    await this.jobs.sources([
      ...issues.map((i) => ({ sourceType: 'ISSUE' as const, sourceId: i.id, force: all })),
      ...comments.map((c) => ({ sourceType: 'COMMENT' as const, sourceId: c.id, force: all })),
      ...uploads.map((u) => ({ sourceType: 'UPLOAD' as const, sourceId: u.id, force: all })),
    ]);
    // Repository jobs compare hashes, so an up-to-date repository costs no embedding calls.
    const repositories = await this.prisma.githubRepository.findMany({
      where: { projects: { some: {} } },
      select: { id: true },
    });
    for (const { id } of repositories) await this.jobs.repository(id, all);

    const counts = {
      removed,
      issues: issues.length,
      comments: comments.length,
      uploads: uploads.length,
      repositories: repositories.length,
    };
    this.logger.log(counts, 'Index backfill queued');
    return counts;
  }

  /**
   * Makes the source's documents match `desired` (one per project): removes documents for
   * projects that no longer apply, writes changed text and embeds it. Unchanged, indexed
   * documents cost nothing.
   */
  private async sync(
    sourceType: DocumentSourceType,
    sourceId: string,
    desired: NormalisedSource[],
    force: boolean,
  ): Promise<{ outcome: IndexOutcome; previousTitles: string[] }> {
    const existing = await this.prisma.document.findMany({
      where: { sourceType, sourceId },
      select: { id: true, projectId: true, contentHash: true, indexedAt: true, title: true },
    });
    const wanted = new Set(desired.map((d) => d.projectId));
    const obsolete = existing.filter((e) => !wanted.has(e.projectId)).map((e) => e.id);
    if (obsolete.length > 0) {
      await this.prisma.document.deleteMany({ where: { id: { in: obsolete } } });
    }

    let outcome: IndexOutcome = desired.length === 0 ? 'deleted' : 'unchanged';
    for (const doc of desired) {
      const hash = contentHash(doc);
      const current = existing.find((e) => e.projectId === doc.projectId);
      if (current?.contentHash === hash && current.indexedAt && !force) continue;
      const fields = {
        title: doc.title,
        content: doc.content,
        url: doc.url,
        contentHash: hash,
        metadata: doc.metadata,
      };
      const row = current
        ? await this.prisma.document.update({
            where: { id: current.id },
            // Not searchable as current until re-embedded; the backfill retries if this fails.
            data: { ...fields, indexedAt: null },
            select: { id: true },
          })
        : await this.prisma.document.upsert({
            where: {
              sourceType_sourceId_projectId: { sourceType, sourceId, projectId: doc.projectId },
            },
            create: { ...fields, sourceType, sourceId, projectId: doc.projectId },
            update: { ...fields, indexedAt: null },
            select: { id: true },
          });
      // Pending (not yet embedded) wins over indexed, so a job reports what still needs doing.
      const embedded = await this.embed(row.id, doc.projectId);
      outcome = outcome === 'pending' || embedded === 'pending' ? 'pending' : 'indexed';
    }
    return { outcome, previousTitles: existing.map((e) => e.title) };
  }

  /** Asks the AI service to chunk and embed the document, and records the embedding cost. */
  private async embed(documentId: string, projectId: string): Promise<'indexed' | 'pending'> {
    // Without an AI service the text is stored and the backfill embeds it once one is set up.
    if (!this.client.configured) return 'pending';
    const started = Date.now();
    const result = await this.client.index(documentId);
    if (result.embedding.inputTokens > 0) {
      await this.usage.record({
        feature: 'EMBEDDING',
        userId: null,
        projectId,
        model: result.embedding.model,
        usage: {
          inputTokens: result.embedding.inputTokens,
          outputTokens: 0,
          costUsd: result.embedding.costUsd,
        },
        latencyMs: Date.now() - started,
        success: true,
      });
    }
    if (result.status === 'rejected') {
      this.logger.warn({ documentId, detail: result.detail }, 'Document rejected by the indexer');
    }
    return result.status === 'indexed' || result.status === 'unchanged' ? 'indexed' : 'pending';
  }
}
