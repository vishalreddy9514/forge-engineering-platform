import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset cursor: the sort key of the last row returned. Base64url-encoded so clients
 * treat it as a token rather than something to construct.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestException('Invalid cursor');
  return { createdAt, id };
}

/** Generic keyset cursor over several sort-key parts (e.g. [name, id]). */
export function encodeCursorParts(...parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursorParts(cursor: string, count: number): string[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parts) &&
      parts.length === count &&
      parts.every((p): p is string => typeof p === 'string')
    ) {
      return parts;
    }
  } catch {
    // fall through
  }
  throw new BadRequestException('Invalid cursor');
}
