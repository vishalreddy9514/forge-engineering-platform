import { z } from 'zod';

/**
 * Auth request/response contracts. The API validates requests with these exact schemas and
 * the web app's forms use them too, so client-side and server-side rules cannot drift apart.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

/**
 * NIST SP 800-63B: length over composition rules. Long passphrases are allowed; the upper
 * bound only stops hash-flooding with megabyte "passwords". Breached passwords are rejected
 * separately by the API (k-anonymity check against Have I Been Pwned).
 */
export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const DisplayName = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(100, 'Use at most 100 characters');

export const RegisterRequest = z.object({
  email: Email,
  displayName: DisplayName,
  password: Password,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/** Login only checks presence: policy rules apply when a password is set, not when used. */
export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PasswordResetRequest = z.object({ email: Email });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

export const PasswordResetConfirm = z.object({
  token: z.string().min(20).max(200),
  newPassword: Password,
});
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const ChangePasswordRequest = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(PASSWORD_MAX_LENGTH),
    newPassword: Password,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.optional(),
    avatarUrl: z
      .url({ protocol: /^https$/, message: 'Use an https:// URL' })
      .max(2048)
      .nullable()
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const UserProfile = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  isAdmin: z.boolean(),
  createdAt: z.string(),
});
export type UserProfile = z.infer<typeof UserProfile>;

/** Returned by login, register and refresh. The refresh token travels only as an httpOnly cookie. */
export const AuthResponse = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  user: UserProfile,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** Admin user management (FR-2.1). */
export const AdminUpdateUserRequest = z
  .object({
    isActive: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((body) => body.isActive !== undefined || body.isAdmin !== undefined, {
    message: 'Nothing to update',
  });
export type AdminUpdateUserRequest = z.infer<typeof AdminUpdateUserRequest>;

export const AdminUser = UserProfile.extend({
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

/** Name of the non-secret cookie that tells the web app a session probably exists. */
export const SESSION_HINT_COOKIE = 'forge_session';
