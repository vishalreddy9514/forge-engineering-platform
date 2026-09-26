import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Cursor pagination query (architecture §14). The cursor is opaque to clients: the API
 * encodes the sort key of the last row it returned, so pages stay stable under inserts.
 */
export const CursorPaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuery>;

export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}
