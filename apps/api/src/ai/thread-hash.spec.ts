import { type Thread, threadHash } from './thread-hash';

const base: Thread = {
  title: 'Refunds fail',
  description: 'Partial captures',
  status: 'TODO',
  comments: [{ id: 'c1', authorId: 'u1', body: 'Seen on prod' }],
};

describe('threadHash', () => {
  it('is stable for the same thread', () => {
    expect(threadHash(base)).toBe(threadHash(structuredClone(base)));
    expect(threadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['title', { title: 'Refunds fail!' }],
    ['description', { description: 'Partial captures.' }],
    ['no description', { description: null }],
    ['status', { status: 'DONE' }],
    ['a comment edit', { comments: [{ id: 'c1', authorId: 'u1', body: 'Seen on prod!' }] }],
    ['a new comment', { comments: [...base.comments, { id: 'c2', authorId: 'u2', body: 'x' }] }],
  ])('changes with %s', (_, change) => {
    expect(threadHash({ ...base, ...change })).not.toBe(threadHash(base));
  });

  it('does not confuse text moved between fields', () => {
    expect(threadHash({ ...base, title: 'ab', description: 'c' })).not.toBe(
      threadHash({ ...base, title: 'a', description: 'bc' }),
    );
    expect(threadHash({ ...base, description: '' })).not.toBe(
      threadHash({ ...base, description: null }),
    );
  });
});
