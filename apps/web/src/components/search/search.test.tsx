import type { Citation } from '@forge/types';
import { render, screen, within } from '@testing-library/react';

import { CitedAnswer, splitCitations } from './cited-answer';
import { RelatedIssueList } from './related-issues';

const citations: Citation[] = [
  {
    n: 1,
    sourceType: 'ISSUE',
    title: 'PAY-1: Double charge',
    url: '/projects/PAY/issues/PAY-1',
    projectKey: 'PAY',
    headingPath: null,
  },
  {
    n: 2,
    sourceType: 'PULL_REQUEST',
    title: 'PR #41: Dedupe',
    url: 'https://github.com/acme/pay/pull/41',
    projectKey: 'PAY',
    headingPath: null,
  },
  {
    n: 3,
    sourceType: 'UPLOAD',
    title: 'Payments runbook',
    url: '/projects/PAY/documents/d',
    projectKey: 'PAY',
    headingPath: 'Duplicate charges',
  },
];

describe('splitCitations', () => {
  it('keeps text and citation numbers in order', () => {
    expect(splitCitations('Retries [1] were deduplicated [2][3].')).toEqual([
      'Retries ',
      1,
      ' were deduplicated ',
      2,
      3,
      '.',
    ]);
    expect(splitCitations('No sources.')).toEqual(['No sources.']);
  });
});

describe('CitedAnswer', () => {
  it('links each citation to its source and lists the sources', () => {
    render(
      <CitedAnswer
        answer="Fixed by deduplicating [1], merged in [2]. See [3]."
        citations={citations}
      />,
    );

    expect(screen.getByLabelText('Source 1: PAY-1: Double charge').closest('a')).toHaveAttribute(
      'href',
      '/projects/PAY/issues/PAY-1',
    );
    const external = screen.getByLabelText('Source 2: PR #41: Dedupe').closest('a');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');

    const sources = within(screen.getByRole('list', { name: 'Sources' })).getAllByRole('listitem');
    expect(sources).toHaveLength(3);
    expect(sources[2]).toHaveTextContent('Payments runbook › Duplicate charges');
  });

  it('shows a number with no matching source as plain text', () => {
    render(<CitedAnswer answer="Unclear [9]." citations={[]} />);
    expect(screen.getByText('Unclear [9].')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Sources' })).not.toBeInTheDocument();
  });
});

describe('RelatedIssueList', () => {
  it('shows each related issue with its key, status and similarity', () => {
    render(
      <RelatedIssueList
        projectKey="PAY"
        issues={[
          {
            id: '01900000-0000-7000-8000-000000000001',
            key: 'PAY-7',
            title: 'Duplicate receipts',
            status: 'DONE',
            type: 'BUG',
            score: 0.8123,
          },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: /PAY-7 Duplicate receipts/ });
    expect(link).toHaveAttribute('href', '/projects/PAY/issues/PAY-7');
    expect(screen.getByText('81%')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});
