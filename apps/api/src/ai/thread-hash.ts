import { createHash } from 'node:crypto';

export interface Thread {
  title: string;
  description: string | null;
  status: string;
  comments: { id: string; authorId: string; body: string }[];
}

/**
 * Identifies the content a summary was made from (FR-7.2). Same thread → same hash → cached
 * summary; any edit to the title, description, status or a comment → new hash, so the old
 * summary is shown as out of date instead of silently wrong. Length-prefixed fields, so moving
 * text from one field to the next never produces the same input.
 */
export function threadHash(thread: Thread): string {
  const hash = createHash('sha256');
  const field = (value: string) => {
    hash.update(`${String(Buffer.byteLength(value))}:`);
    hash.update(value);
  };
  field(thread.title);
  field(thread.description ?? '\u0000');
  field(thread.status);
  for (const comment of thread.comments) {
    field(comment.id);
    field(comment.authorId);
    field(comment.body);
  }
  return hash.digest('hex');
}
