import {
  type DocumentSourceType,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from '@forge/types';
import { createHash } from 'node:crypto';

/**
 * Turns a source row into the text that is chunked, embedded and cited (architecture §7.2,
 * "Normalise"). A header line names the source ("Issue PAY-12: …"), so its key and title are
 * searchable by keyword and give each chunk context; the AI service's eval corpus
 * (apps/ai-service/evals/corpus.jsonl) is written in exactly this form.
 */
export interface NormalisedSource {
  sourceType: DocumentSourceType;
  sourceId: string | null;
  projectId: string;
  title: string;
  content: string;
  url: string;
  metadata: Record<string, string | number | null>;
}

const TITLE_MAX = 300;

export const contentHash = (source: Pick<NormalisedSource, 'title' | 'content'>): string =>
  createHash('sha256').update(`${source.title}\n${source.content}`).digest('hex');

const clip = (text: string, max = TITLE_MAX) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const issueUrl = (projectKey: string, number: number) =>
  `/projects/${projectKey}/issues/${projectKey}-${String(number)}`;

export interface IssueSource {
  id: string;
  projectId: string;
  projectKey: string;
  number: number;
  title: string;
  description: string | null;
  type: IssueType;
  priority: IssuePriority;
  status: IssueStatus;
  assignee: string | null;
  labels: string[];
}

export function normaliseIssue(issue: IssueSource): NormalisedSource {
  const key = `${issue.projectKey}-${String(issue.number)}`;
  const facts = [
    `Type: ${TYPE_LABELS[issue.type]}`,
    `Priority: ${PRIORITY_LABELS[issue.priority]}`,
    `Status: ${STATUS_LABELS[issue.status]}`,
    `Assignee: ${issue.assignee ?? 'unassigned'}`,
    ...(issue.labels.length > 0 ? [`Labels: ${[...issue.labels].sort().join(', ')}`] : []),
  ];
  const header = `Issue ${key}: ${issue.title}\n${facts.join(' · ')}`;
  const body = issue.description?.trim();
  return {
    sourceType: 'ISSUE',
    sourceId: issue.id,
    projectId: issue.projectId,
    title: clip(`${key}: ${issue.title}`),
    content: body ? `${header}\n\n${body}` : header,
    url: issueUrl(issue.projectKey, issue.number),
    metadata: { issueKey: key, status: issue.status, type: issue.type },
  };
}

export interface CommentSource {
  id: string;
  body: string;
  author: string | null;
  issue: { projectId: string; projectKey: string; number: number; title: string };
}

export function normaliseComment(comment: CommentSource): NormalisedSource {
  const { issue } = comment;
  const key = `${issue.projectKey}-${String(issue.number)}`;
  return {
    sourceType: 'COMMENT',
    sourceId: comment.id,
    projectId: issue.projectId,
    title: clip(`Comment on ${key}`),
    // The issue's title gives a short comment ("Fixed with a unique constraint") its topic.
    content: `Comment on ${key} (${issue.title}) by ${comment.author ?? 'a former member'}:\n\n${comment.body.trim()}`,
    url: `${issueUrl(issue.projectKey, issue.number)}#comment-${comment.id}`,
    metadata: { issueKey: key },
  };
}

export interface PullRequestSource {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  authorLogin: string | null;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
  repository: string;
}

export function normalisePullRequest(pr: PullRequestSource, projectId: string): NormalisedSource {
  const state = pr.state.toLowerCase() + (pr.isDraft && pr.state === 'OPEN' ? ' (draft)' : '');
  const header =
    `Pull request #${String(pr.number)} in ${pr.repository}: ${pr.title}\n` +
    `State: ${state} · Author: ${pr.authorLogin ?? 'unknown'} · Branch: ${pr.headRef} → ${pr.baseRef}`;
  const body = pr.body?.trim();
  return {
    sourceType: 'PULL_REQUEST',
    sourceId: pr.id,
    projectId,
    title: clip(`PR #${String(pr.number)}: ${pr.title}`),
    content: body ? `${header}\n\n${body}` : header,
    url: pr.htmlUrl,
    metadata: { repository: pr.repository, number: pr.number, state: pr.state },
  };
}

export interface CommitSource {
  id: string;
  sha: string;
  message: string;
  authorLogin: string | null;
  authorName: string | null;
  htmlUrl: string;
  repository: string;
}

/** Message and metadata only: diffs are noisy and expensive to embed (architecture §7.2). */
export function normaliseCommit(commit: CommitSource, projectId: string): NormalisedSource {
  const short = commit.sha.slice(0, 7);
  const subject = commit.message.split('\n', 1)[0]?.trim() ?? '';
  const author = commit.authorName ?? commit.authorLogin ?? 'unknown';
  return {
    sourceType: 'COMMIT',
    sourceId: commit.id,
    projectId,
    title: clip(`Commit ${short}: ${subject}`),
    content: `Commit ${short} in ${commit.repository} by ${author}:\n\n${commit.message.trim()}`,
    url: commit.htmlUrl,
    metadata: { repository: commit.repository, sha: commit.sha },
  };
}

export const documentUrl = (projectKey: string, documentId: string) =>
  `/projects/${projectKey}/documents/${documentId}`;
