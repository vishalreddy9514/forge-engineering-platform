import { IssueStatus } from './enums';
import {
  canTransition,
  CreateIssueRequest,
  ISSUE_TRANSITIONS,
  isResolved,
  ListIssuesQuery,
  parseIssueKey,
  UpdateIssueRequest,
} from './issues';

describe('issue workflow', () => {
  it.each([
    ['BACKLOG', 'TODO', true],
    ['TODO', 'IN_PROGRESS', true],
    ['IN_PROGRESS', 'IN_REVIEW', true],
    ['IN_REVIEW', 'DONE', true],
    ['DONE', 'TODO', true], // reopen
    ['CANCELLED', 'BACKLOG', true],
    ['BACKLOG', 'DONE', false], // must be worked on first
    ['TODO', 'IN_REVIEW', false],
    ['DONE', 'CANCELLED', false],
    ['DONE', 'IN_REVIEW', false],
    ['CANCELLED', 'DONE', false],
  ] as const)('%s → %s: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('treats "no change" as allowed', () => {
    for (const status of IssueStatus.options) expect(canTransition(status, status)).toBe(true);
  });

  it('lets every unfinished status be cancelled and every finished one be reopened', () => {
    for (const status of IssueStatus.options) {
      if (isResolved(status)) {
        expect(ISSUE_TRANSITIONS[status].some((to) => !isResolved(to))).toBe(true);
      } else {
        expect(canTransition(status, 'CANCELLED')).toBe(true);
      }
    }
  });
});

describe('parseIssueKey', () => {
  it.each([
    ['PAY-12', { projectKey: 'PAY', number: 12 }],
    ['pay-12', { projectKey: 'PAY', number: 12 }],
    [' AUTH2-1 ', { projectKey: 'AUTH2', number: 1 }],
  ])('%j', (key, expected) => {
    expect(parseIssueKey(key)).toEqual(expected);
  });

  it.each(['PAY', 'PAY-0', 'PAY--1', '1PAY-1', 'PAY-1a', 'P-1'])('rejects %j', (key) => {
    expect(parseIssueKey(key)).toBeNull();
  });
});

describe('issue schemas', () => {
  it('applies creation defaults', () => {
    expect(CreateIssueRequest.parse({ title: ' Fix it ' })).toEqual({
      title: 'Fix it',
      type: 'TASK',
      priority: 'MEDIUM',
      status: 'BACKLOG',
      labelIds: [],
    });
  });

  it('only allows new issues in the backlog or to do', () => {
    expect(CreateIssueRequest.safeParse({ title: 'x', status: 'DONE' }).success).toBe(false);
  });

  it('rejects duplicate label ids', () => {
    const id = '01920000-0000-7000-8000-000000000001';
    expect(CreateIssueRequest.safeParse({ title: 'x', labelIds: [id, id] }).success).toBe(false);
  });

  it('requires a version and at least one change on update', () => {
    expect(UpdateIssueRequest.safeParse({ title: 'x' }).success).toBe(false);
    expect(UpdateIssueRequest.safeParse({ version: 3 }).success).toBe(false);
    expect(UpdateIssueRequest.safeParse({ version: 3, title: 'x' }).success).toBe(true);
  });

  it('parses comma-separated filters from the query string', () => {
    expect(ListIssuesQuery.parse({ status: 'TODO,IN_PROGRESS', assignee: 'me' })).toMatchObject({
      status: ['TODO', 'IN_PROGRESS'],
      assignee: 'me',
      sort: 'updated',
    });
    expect(ListIssuesQuery.safeParse({ status: 'TODO,NOPE' }).success).toBe(false);
  });
});
