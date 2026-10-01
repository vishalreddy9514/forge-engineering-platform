import type { PrismaService } from '../infrastructure/database/prisma.service';
import type { SummaryInput } from './ai.client';
import { threadHash } from './thread-hash';

export interface LoadedThread {
  projectId: string;
  issueKey: string;
  issueTitle: string;
  projectKey: string;
  hash: string;
  input: SummaryInput;
}

/** An issue and its live comments, as the summary is made from them, with the content hash. */
export async function loadThread(
  prisma: PrismaService,
  issueId: string,
): Promise<LoadedThread | null> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, deletedAt: null },
    select: {
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      type: true,
      projectId: true,
      project: { select: { key: true } },
      comments: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          body: true,
          createdAt: true,
          authorId: true,
          author: { select: { displayName: true } },
        },
      },
    },
  });
  if (!issue) return null;
  const key = `${issue.project.key}-${String(issue.number)}`;
  return {
    projectId: issue.projectId,
    projectKey: issue.project.key,
    issueKey: key,
    issueTitle: issue.title,
    hash: threadHash({
      title: issue.title,
      description: issue.description,
      status: issue.status,
      comments: issue.comments.map((c) => ({ id: c.id, authorId: c.authorId, body: c.body })),
    }),
    input: {
      issue: {
        key,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        type: issue.type,
      },
      comments: issue.comments.map((c) => ({
        author: c.author.displayName,
        createdAt: c.createdAt.toISOString(),
        body: c.body,
      })),
    },
  };
}
