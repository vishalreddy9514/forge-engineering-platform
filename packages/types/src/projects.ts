import { z } from 'zod';

import { ProjectRole } from './enums';
import { CursorPaginationQuery } from './pagination';

/** PAY, AUTH, WEB2… Immutable once created: issue keys (PAY-123) are built from it. */
export const ProjectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2–10 letters or digits, starting with a letter');

export const ProjectName = z.string().trim().min(1, 'Enter a project name').max(100);
const Description = z.string().trim().max(5000);

export const CreateProjectRequest = z.object({
  key: ProjectKey,
  name: ProjectName,
  description: Description.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z
  .object({
    name: ProjectName.optional(),
    description: Description.nullable().optional(),
    /** Must be a project member; null clears it. */
    defaultAssigneeId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ListProjectsQuery = CursorPaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuery>;

export const UserSummary = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const ProjectSummary = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  /** The caller's role; ADMIN when the caller is a platform admin without membership. */
  myRole: z.union([ProjectRole, z.literal('ADMIN')]),
  memberCount: z.number().int(),
  openIssueCount: z.number().int(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = ProjectSummary.extend({
  defaultAssignee: UserSummary.nullable(),
  createdBy: UserSummary,
  activeSprint: z.object({ id: z.uuid(), name: z.string(), endDate: z.string() }).nullable(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const ProjectMember = z.object({
  user: UserSummary,
  role: ProjectRole,
  addedAt: z.string(),
});
export type ProjectMember = z.infer<typeof ProjectMember>;

export const AddMemberRequest = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: 'Enter a valid email address' })),
  role: ProjectRole,
});
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const UpdateMemberRequest = z.object({ role: ProjectRole });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const LabelColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1d76db')
  .transform((c) => c.toLowerCase());

export const Label = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  issueCount: z.number().int(),
});
export type Label = z.infer<typeof Label>;

export const CreateLabelRequest = z.object({
  name: z.string().trim().min(1, 'Enter a label name').max(50),
  color: LabelColor,
  description: z.string().trim().max(200).optional(),
});
export type CreateLabelRequest = z.infer<typeof CreateLabelRequest>;

export const UpdateLabelRequest = CreateLabelRequest.partial()
  .extend({ description: z.string().trim().max(200).nullable().optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateLabelRequest = z.infer<typeof UpdateLabelRequest>;

export const ROLE_LABELS: Record<ProjectRole, string> = {
  PROJECT_MANAGER: 'Project manager',
  DEVELOPER: 'Developer',
  VIEWER: 'Viewer',
};
