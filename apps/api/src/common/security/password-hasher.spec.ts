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

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });
});
