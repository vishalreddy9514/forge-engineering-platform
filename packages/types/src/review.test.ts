import { describeNotification, notificationHref } from './notifications';
import { REVIEW_DISCLAIMER, reviewToMarkdown } from './review';

describe('reviewToMarkdown', () => {
  it('writes the disclaimer, summary, findings with locations, and missing tests', () => {
    const markdown = reviewToMarkdown({
      summary: 'Adds a lookup. One critical issue.',
      findings: [
        {
          file: 'app/db.py',
          line: 42,
          severity: 'critical',
          category: 'security',
          explanation: 'SQL is concatenated.',
          suggestion: 'Use a parameterised query.',
        },
        {
          file: 'app/db.py',
          line: null,
          severity: 'nit',
          category: 'style',
          explanation: 'Long function.',
          suggestion: '',
        },
      ],
      missingTests: [{ description: 'Test the lookup.', file: 'app/db.py' }],
    });
    expect(markdown).toBe(
      [
        '## AI review',
        '',
        `> ${REVIEW_DISCLAIMER}`,
        '',
        'Adds a lookup. One critical issue.',
        '',
        '### Findings',
        '',
        '- **critical** (security) `app/db.py:42`: SQL is concatenated.',
        '  - Suggestion: Use a parameterised query.',
        '- **nit** (style) `app/db.py`: Long function.',
        '',
        '### Missing tests',
        '',
        '- Test the lookup. (`app/db.py`)',
        '',
      ].join('\n'),
    );
  });

  it('omits empty sections', () => {
    expect(
      reviewToMarkdown({ summary: 'Nothing found.', findings: [], missingTests: [] }),
    ).not.toContain('###');
  });
});

describe('AI review notifications', () => {
  const base = {
    id: '01900000-0000-7000-8000-000000000001',
    readAt: null,
    createdAt: '2026-10-01T00:00:00Z',
  };
  const payload = {
    projectKey: 'PAY',
    jobId: 'j',
    repository: 'acme/pay',
    pullRequestId: '01900000-0000-7000-8000-0000000000aa',
    pullRequestNumber: 41,
    pullRequestTitle: 'Lookup',
  };

  it('names the pull request and links to its page', () => {
    const done = { ...base, type: 'AI_JOB_COMPLETED' as const, payload };
    expect(describeNotification(done)).toBe('The AI review of acme/pay#41 is ready');
    expect(notificationHref(done)).toBe(`/projects/PAY/pull-requests/${payload.pullRequestId}`);
    expect(describeNotification({ ...done, type: 'AI_JOB_FAILED' })).toBe(
      'The AI review of acme/pay#41 could not be made',
    );
  });
});
