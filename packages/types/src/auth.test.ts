import {
  ChangePasswordRequest,
  Email,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RegisterRequest,
  UpdateProfileRequest,
} from './auth';

describe('auth schemas', () => {
  it('normalises emails (trim + lowercase) so lookups are consistent', () => {
    expect(Email.parse('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it.each(['not-an-email', 'a@', '@b.com', ''])('rejects email %j', (email) => {
    expect(Email.safeParse(email).success).toBe(false);
  });

  it('requires a password of at least the minimum length, with no composition rules', () => {
    const base = { email: 'a@b.co', displayName: 'A' };
    expect(
      RegisterRequest.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) }).success,
    ).toBe(false);
    expect(RegisterRequest.safeParse({ ...base, password: 'correct horse battery' }).success).toBe(
      true,
    );
  });

  it('accepts long passphrases in any script, with spaces and emoji (ASVS 2.1.2, 2.1.4)', () => {
    const base = { email: 'a@b.co', displayName: 'A' };
    // Counted in characters (code points): the emoji is one character, not two.
    const longest = Array.from('ключ 鍵 🔑 '.repeat(20)).slice(0, PASSWORD_MAX_LENGTH).join('');
    expect(Array.from(longest)).toHaveLength(PASSWORD_MAX_LENGTH);
    expect(RegisterRequest.safeParse({ ...base, password: longest }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...base, password: `${longest}x` }).success).toBe(false);
  });

  it('rejects a new password equal to the current one', () => {
    const result = ChangePasswordRequest.safeParse({
      currentPassword: 'same password here',
      newPassword: 'same password here',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['newPassword']);
  });

  it('only accepts https avatar URLs (no javascript: or http: links)', () => {
    expect(UpdateProfileRequest.safeParse({ avatarUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(UpdateProfileRequest.safeParse({ avatarUrl: 'http://x.test/a.png' }).success).toBe(
      false,
    );
    expect(UpdateProfileRequest.safeParse({ avatarUrl: 'https://x.test/a.png' }).success).toBe(
      true,
    );
  });

  it('rejects an empty profile update', () => {
    expect(UpdateProfileRequest.safeParse({}).success).toBe(false);
  });
});
