import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness, URL-safe. Used for refresh and password-reset tokens. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored only as SHA-256 hashes. A fast hash is right here (unlike passwords): the
 * input already has 256 bits of entropy, so there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
