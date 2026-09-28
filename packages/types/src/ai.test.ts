import {
  DraftRequest,
  draftToDescription,
  DraftStreamEvent,
  IssueDraft,
  SummaryRequested,
} from './ai';

const draft = {
  title: 'Refunds fail for partial captures',
  description: 'The refund endpoint returns 500.',
  acceptanceCriteria: ['Given a partial capture, when refunded, then it succeeds'],
  type: 'BUG',
  priority: 'HIGH',
  priorityRationale: 'Money is stuck.',
  labels: ['payments'],
  technicalArea: 'payments API',
};

describe('AI contracts', () => {
  it('validates drafts the way the model is constrained', () => {
    expect(IssueDraft.parse(draft)).toEqual(draft);
    expect(IssueDraft.safeParse({ ...draft, priority: 'URGENT' }).success).toBe(false);
    expect(IssueDraft.safeParse({ ...draft, acceptanceCriteria: [] }).success).toBe(false);
  });

  it('requires a real sentence to draft from', () => {
    expect(DraftRequest.safeParse({ text: '  too short ' }).success).toBe(false);
    expect(DraftRequest.parse({ text: '  Checkout crashes on Safari 17  ' }).text).toBe(
      'Checkout crashes on Safari 17',
    );
  });

  it('turns a draft into a description with a task list of acceptance criteria', () => {
    expect(draftToDescription(IssueDraft.parse(draft))).toBe(
      'The refund endpoint returns 500.\n\n## Acceptance criteria\n\n' +
        '- [ ] Given a partial capture, when refunded, then it succeeds',
    );
  });

  it('parses stream events and summary responses by their tag', () => {
    expect(DraftStreamEvent.parse({ event: 'delta', data: { text: '{"ti' } }).event).toBe('delta');
    expect(
      DraftStreamEvent.safeParse({ event: 'result', data: { draft: {}, droppedLabels: [] } })
        .success,
    ).toBe(false);
    expect(
      SummaryRequested.parse({
        status: 'queued',
        statusUrl: '/api/v1/ai/jobs/x',
        job: {
          id: '0192f3a4-0000-7000-8000-000000000001',
          type: 'ISSUE_SUMMARY',
          status: 'QUEUED',
          error: null,
          createdAt: '2026-09-28T00:00:00Z',
          finishedAt: null,
        },
      }).status,
    ).toBe('queued');
  });
});
