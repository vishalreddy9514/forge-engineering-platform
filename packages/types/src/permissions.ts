import type { ProjectRole } from './enums';

/**
 * Project-scoped permissions and which roles hold them: the permission matrix from
 * docs/requirements.md §2, as code (ADR-0002). Reviewed in PRs and unit-tested as a table;
 * it cannot be edited at runtime. Shared so the web app hides actions a role cannot take;
 * the API enforces the same table on every request.
 */
export const PERMISSIONS = [
  'project:read',
  'project:update',
  'project:archive',
  'member:manage',
  'issue:create',
  'issue:update',
  'issue:delete',
  'comment:create',
  /** Edit or delete other people's comments (own comments are checked in the service). */
  'comment:moderate',
  'attachment:create',
  'sprint:manage',
  'github:link',
  'github:sync',
  /** AI features that create content: drafts, summaries, related issues, PR reviews. */
  'ai:write',
  /** Read-only AI: assistant chat and semantic search over the project. */
  'ai:read',
  'document:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const DEVELOPER: readonly Permission[] = [
  'project:read',
  'issue:create',
  'issue:update',
  'comment:create',
  'attachment:create',
  'github:sync',
  'ai:write',
  'ai:read',
  'document:write',
];

const VIEWER: readonly Permission[] = ['project:read', 'ai:read'];

const ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<Permission>> = {
  PROJECT_MANAGER: new Set(PERMISSIONS),
  DEVELOPER: new Set(DEVELOPER),
  VIEWER: new Set(VIEWER),
};

/** Platform admins can do everything in every project. */
export type EffectiveRole = ProjectRole | 'ADMIN';

export function can(role: EffectiveRole, permission: Permission): boolean {
  return role === 'ADMIN' || ROLE_PERMISSIONS[role].has(permission);
}
