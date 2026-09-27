import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * Verifies GitHub's `X-Hub-Signature-256` header: HMAC-SHA256 of the exact request bytes with
 * the webhook secret. Compared in constant time so response timing reveals nothing about the
 * expected value. Anything malformed is simply "not valid".
 */
export function isValidWebhookSignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith(PREFIX)) return false;
  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  // A non-hex or truncated value decodes to a different length; timingSafeEqual needs equal ones.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Signs a body the way GitHub does (tests and local webhook replay). */
export function signWebhookBody(secret: string, body: Buffer | string): string {
  return PREFIX + createHmac('sha256', secret).update(body).digest('hex');
}
