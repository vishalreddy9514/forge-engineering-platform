import { BadRequestException } from '@nestjs/common';

import { decodeCursor, decodeCursorParts, encodeCursor, encodeCursorParts } from './cursor';

describe('cursors', () => {
  it('round-trips a (createdAt, id) cursor', () => {
    const createdAt = new Date('2026-09-26T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(createdAt, 'abc'))).toEqual({ createdAt, id: 'abc' });
  });

  it('round-trips multi-part cursors, including separators inside values', () => {
    const parts = ['Payments | Platform', '0192…'];
    expect(decodeCursorParts(encodeCursorParts(...parts), 2)).toEqual(parts);
  });

  it.each(['not-base64-json', encodeCursorParts('only-one'), encodeCursorParts('a', 'b', 'c')])(
    'rejects a malformed cursor (%j)',
    (cursor) => {
      expect(() => decodeCursorParts(cursor, 2)).toThrow(BadRequestException);
    },
  );
});
