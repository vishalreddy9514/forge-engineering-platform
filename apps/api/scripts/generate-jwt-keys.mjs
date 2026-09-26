// Prints a fresh ES256 key pair as .env lines (PEM with "\n" escapes).
//   node apps/api/scripts/generate-jwt-keys.mjs >> .env
// In AWS the same values go into SSM Parameter Store, never into the repository.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const escape = (pem) => pem.trim().replace(/\n/g, '\\n');

process.stdout.write(
  `JWT_PRIVATE_KEY="${escape(privateKey)}"\nJWT_PUBLIC_KEY="${escape(publicKey)}"\n`,
);
