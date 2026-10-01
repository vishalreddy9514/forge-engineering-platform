import type { RelatedIssue, SemanticSearchQuery, SemanticSearchResponse } from '@forge/types';
import { Injectable, NotFoundException } from '@nestjs/common';

import { AiUsageService } from '../ai/ai-usage.service';
import { AiClient } from '../ai/ai.client';
import { AiUnavailableException } from '../ai/ai.errors';
import type { WireEmbeddingUsage } from '../ai/ai.wire';
import type { AuthUser } from '../auth/auth.types';
import type { AiFeature } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import type { ReadableProject } from './query-issues';

/** Interactive retrieval answers within this or reports the AI as unavailable. */
const SEARCH_TIMEOUT_MS = 15_000;
const RELATED_LIMIT = 5;

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
  ) {}

  /**
   * The projects retrieval may read for this user (architecture §7.4): their memberships, or
   * every project for a platform admin. Narrowed to one project when asked; a project the user
   * cannot read is "not found", like every other project-scoped route.
   */
  async readableProjects(user: AuthUser, projectId?: string): Promise<ReadableProject[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        ...(user.isAdmin ? {} : { members: { some: { userId: user.id } } }),
        ...(projectId ? { id: projectId } : {}),
      },
      select: { id: true, key: true, name: true },
      orderBy: { key: 'asc' },
    });
    if (projectId && projects.length === 0) throw new NotFoundException('Project not found');
    return projects;
  }

  /** FR-11.2: hybrid retrieval over everything the user can read, one result per document. */
  async semantic(user: AuthUser, query: SemanticSearchQuery): Promise<SemanticSearchResponse> {
    const projects = await this.readableProjects(user, query.projectId);
    if (projects.length === 0) return { data: [] };
    if (!this.client.configured) throw new AiUnavailableException();
    await this.usage.assertWithinBudget(user.id);

    const started = Date.now();
    const response = await this.client.search(
      {
        query: query.q,
        projectIds: projects.map((p) => p.id),
        ...(query.type ? { sourceTypes: query.type } : {}),
        limit: query.limit,
      },
      AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    );
    await this.recordEmbedding(
      'SEMANTIC_SEARCH',
      user.id,
      query.projectId ?? null,
      response.embedding,
      started,
    );

    // The AI service filters by project in SQL; this second check means a bug there still
    // cannot show the user a result from a project they cannot read.
    const keys = new Map(projects.map((p) => [p.id, p.key]));
    return {
      data: response.results.flatMap((r) => {
        const projectKey = keys.get(r.projectId);
        return projectKey
          ? [
              {
                documentId: r.documentId,
                projectId: r.projectId,
                projectKey,
                sourceType: r.sourceType,
                title: r.title,
                url: r.url,
                headingPath: r.headingPath,
                snippet: r.snippet,
                score: r.score,
              },
            ]
          : [];
      }),
    };
  }

  /** FR-7.3: similar issues in the same project, for an existing issue (its stored vector). */
  async relatedToIssue(issueId: string, user: AuthUser): Promise<RelatedIssue[]> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { projectId: true, title: true, description: true },
    });
    if (!issue) throw new NotFoundException('Issue not found');
    // The text is the fallback for an issue that has not been indexed yet.
    const text = `${issue.title}\n\n${issue.description ?? ''}`.slice(0, 8000);
    return this.related(issue.projectId, { issueId, text }, user, issueId);
  }

  /** FR-7.3 while drafting: there is no issue yet, so the draft text is embedded. */
  relatedToText(projectId: string, text: string, user: AuthUser): Promise<RelatedIssue[]> {
    return this.related(projectId, { text }, user);
  }

  private async related(
    projectId: string,
    input: { issueId?: string; text?: string },
    user: AuthUser,
    excludeIssueId?: string,
  ): Promise<RelatedIssue[]> {
    if (!this.client.configured) throw new AiUnavailableException();
    // Draft text is always embedded; an indexed issue reuses its stored vector at no cost.
    if (!input.issueId) await this.usage.assertWithinBudget(user.id);
    const started = Date.now();
    const response = await this.client.related(
      { projectId, ...input, limit: RELATED_LIMIT },
      AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    );
    if (response.embedding.inputTokens > 0) {
      await this.recordEmbedding('RELATED_ISSUES', user.id, projectId, response.embedding, started);
    }

    const ids = response.results.map((r) => r.issueId).filter((id) => id !== excludeIssueId);
    const issues = await this.prisma.issue.findMany({
      where: { id: { in: ids }, projectId, deletedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        type: true,
        project: { select: { key: true } },
      },
    });
    const byId = new Map(issues.map((i) => [i.id, i]));
    // Keep the AI service's order (most similar first) and drop anything deleted since indexing.
    return response.results.flatMap((r) => {
      const issue = byId.get(r.issueId);
      if (!issue || issue.id === excludeIssueId) return [];
      return [
        {
          id: issue.id,
          key: `${issue.project.key}-${String(issue.number)}`,
          title: issue.title,
          status: issue.status,
          type: issue.type,
          score: r.score,
        },
      ];
    });
  }

  private recordEmbedding(
    feature: AiFeature,
    userId: string,
    projectId: string | null,
    embedding: WireEmbeddingUsage,
    started: number,
  ) {
    return this.usage.record({
      feature,
      userId,
      projectId,
      model: embedding.model,
      usage: { inputTokens: embedding.inputTokens, outputTokens: 0, costUsd: embedding.costUsd },
      latencyMs: Date.now() - started,
      success: true,
    });
  }
}
