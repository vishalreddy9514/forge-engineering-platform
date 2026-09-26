import { generateKeyPairSync } from 'node:crypto';

import { loadJwtKeys } from './jwt-keys';

describe('loadJwtKeys', () => {
  it('uses configured keys, accepting "\\n"-escaped PEM from env files', () => {
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const keys = loadJwtKeys({
      JWT_PRIVATE_KEY: pair.privateKey.replace(/\n/g, '\\n'),
      JWT_PUBLIC_KEY: pair.publicKey.replace(/\n/g, '\\n'),
    });
    expect(keys.privateKey).toBe(pair.privateKey);
    expect(keys.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('derives a stable key ID from the public key', () => {
    const a = loadJwtKeys({});
    expect(loadJwtKeys({ JWT_PRIVATE_KEY: a.privateKey, JWT_PUBLIC_KEY: a.publicKey }).kid).toBe(
      a.kid,
    );
  });
});
