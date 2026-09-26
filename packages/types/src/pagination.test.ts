import { CursorPaginationQuery, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination';

describe('CursorPaginationQuery', () => {
  it('applies the default page size when limit is omitted', () => {
    expect(CursorPaginationQuery.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('coerces a numeric string from the query string', () => {
    expect(CursorPaginationQuery.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    });
  });

  it.each([0, -1, MAX_PAGE_SIZE + 1, 2.5])('rejects limit=%p', (limit) => {
    expect(CursorPaginationQuery.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an empty cursor', () => {
    expect(CursorPaginationQuery.safeParse({ cursor: '' }).success).toBe(false);
  });
});
