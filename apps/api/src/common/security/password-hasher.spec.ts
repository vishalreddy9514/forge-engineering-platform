import { hashPassword, verifyPassword } from './password-hasher';

describe('password hasher', () => {
  it('produces an argon2id PHC string with the configured parameters', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hashed, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hashed, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('uses every character: no truncation, unlike bcrypt at 72 bytes (ASVS 2.1.3)', async () => {
    const long = 'p'.repeat(100);
    const hashed = await hashPassword(`${long}A`);
    await expect(verifyPassword(hashed, `${long}B`)).resolves.toBe(false);
    await expect(verifyPassword(hashed, `${long}A`)).resolves.toBe(true);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });
});
