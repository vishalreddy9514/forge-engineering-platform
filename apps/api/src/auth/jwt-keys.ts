import { Logger } from '@nestjs/common';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';

import type { Env } from '../config/env';

export interface JwtKeys {
  privateKey: string;
  publicKey: string;
  /** Key ID in the token header, so keys can be rotated by publishing the next public key. */
  kid: string;
}

/**
 * ES256 (ECDSA P-256) signing keys. Asymmetric keys mean services that only verify tokens
 * need the public key, never the signing key (ADR-0010).
 */
export function loadJwtKeys(env: Pick<Env, 'JWT_PRIVATE_KEY' | 'JWT_PUBLIC_KEY'>): JwtKeys {
  let privateKey = env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  let publicKey = env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');

  if (!privateKey || !publicKey) {
    // Production requires configured keys (enforced by env validation).
    new Logger('JwtKeys').warn(
      'JWT keys not configured: using an ephemeral key pair. Tokens will not survive a restart.',
    );
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  }

  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const kid = createHash('sha256').update(der).digest('base64url').slice(0, 16);
  return { privateKey, publicKey, kid };
}
