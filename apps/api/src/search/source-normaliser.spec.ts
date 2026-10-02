import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeQuery } from './query-issues';
import {
  contentHash,
  normaliseComment,
  normaliseCommit,
  normaliseIssue,
  normalisePullRequest,
} from './source-normaliser';

const issue = {
  id: '01900000-0000-7000-8000-000000000001',
  projectId: '01900000-0000-7000-8000-0000000000aa',
  projectKey: 'PAY',
  number: 1,
  title: 'Stripe webhook retries can double-charge customers',
  description: 'The handler is not idempotent.',
  type: 'BUG' as const,
  priority: 'CRITICAL' as const,
  status: 'DONE' as const,
  assignee: 'Sam Okafor',
  labels: ['payments', 'bug', 'incident'],
};

describe('source normaliser', () => {
  it('writes an issue as a header line, its facts and its description', () => {
    expect(normaliseIssue(issue)).toEqual({
      sourceType: 'ISSUE',
      sourceId: issue.id,
      projectId: issue.projectId,
      title: 'PAY-1: Stripe webhook retries can double-charge customers',
      content:
        'Issue PAY-1: Stripe webhook retries can double-charge customers\n' +
        'Type: Bug · Priority: Critical · Status: Done · Assignee: Sam Okafor · ' +
        'Labels: bug, incident, payments\n\nThe handler is not idempotent.',
      url: '/projects/PAY/issues/PAY-1',
      metadata: { issueKey: 'PAY-1', status: 'DONE', type: 'BUG' },
    });
  });

  it('hashes the same issue the same way whatever order its labels load in', () => {
    const reordered = normaliseIssue({ ...issue, labels: ['incident', 'payments', 'bug'] });
    expect(contentHash(reordered)).toBe(contentHash(normaliseIssue(issue)));
    expect(contentHash(normaliseIssue({ ...issue, status: 'TODO' }))).not.toBe(
      contentHash(normaliseIssue(issue)),
    );
  });

  it('writes the same form as the retrieval eval corpus', () => {
    // The AI service's eval measures retrieval over text in this exact shape (FR-8.6).
    const corpus = readFileSync(join(__dirname, '../../../ai-service/evals/corpus.jsonl'), 'utf8');
    const pay1 = corpus
      .split('\n')
      .map((line) => (line ? (JSON.parse(line) as { id: string; content: string }) : null))
      .find((row) => row?.id === 'PAY-1');
    const expectedHeader = normaliseIssue({ ...issue, labels: [] }).content.split('\n')[0];
    expect(pay1?.content.split('\n')[0]).toBe(expectedHeader);
  });

  it('omits empty descriptions and names unassigned issues', () => {
    const doc = normaliseIssue({ ...issue, description: '  ', assignee: null, labels: [] });
    expect(doc.content).toBe(
      'Issue PAY-1: Stripe webhook retries can double-charge customers\n' +
        'Type: Bug · Priority: Critical · Status: Done · Assignee: unassigned',
    );
  });

  it('gives a comment its issue for context and links to the comment', () => {
    const doc = normaliseComment({
      id: 'c1',
      body: ' Fixed with a unique constraint. ',
      author: null,
      issue: { projectId: 'p', projectKey: 'PAY', number: 1, title: 'Double charges' },
    });
    expect(doc).toMatchObject({
      title: 'Comment on PAY-1',
      content:
        'Comment on PAY-1 (Double charges) by a former member:\n\nFixed with a unique constraint.',
      url: '/projects/PAY/issues/PAY-1#comment-c1',
    });
  });

  it('writes pull requests and commits per project, linking to GitHub', () => {
    const pr = normalisePullRequest(
      {
        id: 'pr1',
        number: 48,
        title: 'Batch the reconciliation query',
        body: null,
        state: 'OPEN',
        isDraft: true,
        authorLogin: 'sam-okafor',
        headRef: 'fix/recon',
        baseRef: 'main',
        htmlUrl: 'https://github.com/acme/pay/pull/48',
        repository: 'acme/pay',
      },
      'project-a',
    );
    expect(pr).toMatchObject({
      projectId: 'project-a',
      title: 'PR #48: Batch the reconciliation query',
      content:
        'Pull request #48 in acme/pay: Batch the reconciliation query\n' +
        'State: open (draft) · Author: sam-okafor · Branch: fix/recon → main',
      url: 'https://github.com/acme/pay/pull/48',
    });
    const commit = normaliseCommit(
      {
        id: 'c1',
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        message: 'Stream reconciliation in pages\n\nFixes PAY-5.',
        authorLogin: 'sam',
        authorName: null,
        htmlUrl: 'https://github.com/acme/pay/commit/abcdef0',
        repository: 'acme/pay',
      },
      'project-b',
    );
    expect(commit).toMatchObject({
      title: 'Commit abcdef0: Stream reconciliation in pages',
      content:
        'Commit abcdef0 in acme/pay by sam:\n\nStream reconciliation in pages\n\nFixes PAY-5.',
    });
  });

  it('caps titles at the column length', () => {
    const doc = normaliseIssue({ ...issue, title: 'x'.repeat(400) });
    expect(doc.title).toHaveLength(300);
    expect(doc.title.endsWith('…')).toBe(true);
  });
});

describe('describeQuery', () => {
  it('describes the filters the assistant chose', () => {
    expect(
      describeQuery({
        project_key: 'PAY',
        type: 'BUG',
        status: 'done',
        priority: 'CRITICAL',
        sprint: 'last_completed',
        updated_within_days: null,
      }),
    ).toBe('Looking up done critical bugs in PAY in the last completed sprint');
    expect(
      describeQuery({
        project_key: 'AUTH',
        type: null,
        status: 'in_progress',
        priority: null,
        sprint: null,
        updated_within_days: 7,
      }),
    ).toBe('Looking up in progress issues in AUTH updated in the last 7 days');
  });
});
