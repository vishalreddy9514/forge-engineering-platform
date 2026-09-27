import type { UserSummary } from '@forge/types';

import type { Prisma } from '../generated/prisma/client';

/** The public face of a user inside a project: never the password hash or admin flags. */
export const USER_SUMMARY_SELECT = {
  id: true,
  displayName: true,
  email: true,
  avatarUrl: true,
} as const satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SUMMARY_SELECT }>;

export function toUserSummary(user: UserRow): UserSummary {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}
