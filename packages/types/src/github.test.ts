import {
  ClaimInstallationRequest,
  commitTitle,
  findIssueKeys,
  ListPullRequestsQuery,
} from './github';

describe('findIssueKeys', () => {
  it.each([
    ['Fix PAY-123 retry loop', ['PAY-123']],
    ['PAY-1, PAY-2 and OPS-10', ['PAY-1', 'PAY-2', 'OPS-10']],
    ['feature/PAY-12-retry-refunds', ['PAY-12']],
    ['(PAY-7): tidy up', ['PAY-7']],
    ['Closes #12, see PAY-4.', ['PAY-4']],
    ['A2B-9 has digits in its key', ['A2B-9']],
    ['PAY-5 then PAY-5 again', ['PAY-5']],
  ])('finds the keys in %j', (text, keys) => {
    expect(findIssueKeys(text)).toEqual(keys);
  });

  it.each([
    'pay-123 is lower case',
    'XPAY-12 has a longer key',
    'PAY-12a continues a word',
    'PAY_12 uses an underscore',
    'PAY-0 is not an issue number',
    'P-12 has a one-letter key',
    'TOOLONGKEYX-1 has an eleven-character key',
    'sha256 SHA-256',
  ])('does not invent PAY keys in %j', (text) => {
    expect(findIssueKeys(text).filter((k) => k.startsWith('PAY-'))).toEqual([]);
  });

  it('only reports what is written: SHA-256 looks like a key, and resolution filters it', () => {
    // The API only links keys of projects linked to the repository, so this never links anything
    // unless a project is really called SHA.
    expect(findIssueKeys('hash with SHA-256')).toEqual(['SHA-256']);
    expect(findIssueKeys('XPAY-12')).toEqual(['XPAY-12']);
  });
});

describe('GitHub request schemas', () => {
  it('accepts an installation ID from the setup redirect query string', () => {
    expect(ClaimInstallationRequest.parse({ installationId: '12345678' })).toEqual({
      installationId: 12345678,
    });
    expect(ClaimInstallationRequest.safeParse({ installationId: '-1' }).success).toBe(false);
    expect(ClaimInstallationRequest.safeParse({ installationId: 'abc' }).success).toBe(false);
  });

  it('filters pull requests by state and repository', () => {
    expect(ListPullRequestsQuery.parse({ state: 'MERGED' })).toMatchObject({
      state: 'MERGED',
      limit: 25,
    });
    expect(ListPullRequestsQuery.safeParse({ state: 'merged' }).success).toBe(false);
    expect(ListPullRequestsQuery.safeParse({ repositoryId: 'nope' }).success).toBe(false);
  });

  it('uses the first line of a commit message as its title', () => {
    expect(commitTitle('Fix PAY-1\n\nLonger body')).toBe('Fix PAY-1');
    expect(commitTitle('')).toBe('');
  });
});
