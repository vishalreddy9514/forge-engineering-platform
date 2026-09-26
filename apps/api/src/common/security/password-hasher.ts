import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the OWASP Password Storage Cheat Sheet's baseline parameters
 * (19 MiB memory, 2 iterations, 1 degree of parallelism). The PHC output string embeds the
 * parameters, so they can be raised later without invalidating existing hashes.
 */
const ARGON2ID = 2;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
