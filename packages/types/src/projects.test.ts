import {
  CreateLabelRequest,
  CreateProjectRequest,
  ListProjectsQuery,
  ProjectKey,
} from './projects';

describe('project schemas', () => {
  it('upper-cases and trims keys', () => {
    expect(ProjectKey.parse(' pay ')).toBe('PAY');
  });

  it.each(['P', '1PAY', 'PAY-1', 'ABCDEFGHIJK', 'PA Y'])('rejects key %j', (key) => {
    expect(ProjectKey.safeParse(key).success).toBe(false);
  });

  it('requires a name', () => {
    expect(CreateProjectRequest.safeParse({ key: 'PAY', name: '  ' }).success).toBe(false);
  });

  it('normalises label colours to lower case and rejects non-hex values', () => {
    expect(CreateLabelRequest.parse({ name: 'bug', color: '#D73A4A' }).color).toBe('#d73a4a');
    expect(CreateLabelRequest.safeParse({ name: 'bug', color: 'red' }).success).toBe(false);
  });

  it('parses the archived flag from the query string', () => {
    expect(ListProjectsQuery.parse({}).archived).toBe(false);
    expect(ListProjectsQuery.parse({ archived: 'true' }).archived).toBe(true);
  });
});
