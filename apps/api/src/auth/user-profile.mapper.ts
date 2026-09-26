import type { AdminUser, UserProfile } from '@forge/types';

import type { User } from '../generated/prisma/client';

/** The only way a user row leaves the API: an allow-list of fields (never the password hash). */
export function toUserProfile(user: User): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAdminUser(user: User): AdminUser {
  return {
    ...toUserProfile(user),
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
