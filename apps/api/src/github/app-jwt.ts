import { type KeyObject, sign } from 'node:crypto';

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The JWT a GitHub App authenticates as itself with (RS256, at most 10 minutes). It is only used
 * to look up installations and mint installation tokens; repository data is always read with an
 * installation token. `iat` is backdated a minute to tolerate clock drift, as GitHub advises.
 */
export function createAppJwt(appId: number, privateKey: KeyObject, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: String(appId),
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}
