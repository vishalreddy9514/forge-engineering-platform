import type { Label, ProjectDetail, ProjectMember, ProjectSummary } from '@forge/types';
import { ProjectRole } from '@forge/types';

import type { EffectiveRole } from '../access-control/permissions';
import type { Prisma } from '../generated/prisma/client';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';

/** The caller's role. Counts come separately (ProjectsService.counts): a Prisma `_count` here
 *  grouped every open issue of every project on each request (Phase 19). */
export const projectSummaryInclude = (userId: string) =>
  ({
    members: { where: { userId }, select: { role: { select: { key: true } } } },
  }) as const satisfies Prisma.ProjectInclude;

export interface ProjectCounts {
  members: number;
  openIssues: number;
}

type SummaryRow = Prisma.ProjectGetPayload<{
  include: ReturnType<typeof projectSummaryInclude>;
}>;

export function toProjectSummary(project: SummaryRow, counts: ProjectCounts): ProjectSummary {
  const membership = project.members[0];
  const myRole: EffectiveRole = membership ? ProjectRole.parse(membership.role.key) : 'ADMIN';
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    myRole,
    memberCount: counts.members,
    openIssueCount: counts.openIssues,
  };
}

export const projectDetailInclude = (userId: string) =>
  ({
    ...projectSummaryInclude(userId),
    defaultAssignee: { select: USER_SUMMARY_SELECT },
    createdBy: { select: USER_SUMMARY_SELECT },
    sprints: {
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, endDate: true },
      take: 1,
    },
  }) as const satisfies Prisma.ProjectInclude;

type DetailRow = Prisma.ProjectGetPayload<{ include: ReturnType<typeof projectDetailInclude> }>;

export function toProjectDetail(project: DetailRow, counts: ProjectCounts): ProjectDetail {
  const sprint = project.sprints[0];
  return {
    ...toProjectSummary(project, counts),
    defaultAssignee: project.defaultAssignee ? toUserSummary(project.defaultAssignee) : null,
    createdBy: toUserSummary(project.createdBy),
    activeSprint: sprint
      ? { id: sprint.id, name: sprint.name, endDate: sprint.endDate.toISOString().slice(0, 10) }
      : null,
  };
}

export const MEMBER_INCLUDE = {
  user: { select: USER_SUMMARY_SELECT },
  role: { select: { key: true } },
} as const satisfies Prisma.ProjectMemberInclude;

type MemberRow = Prisma.ProjectMemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

export function toProjectMember(member: MemberRow): ProjectMember {
  return {
    user: toUserSummary(member.user),
    role: ProjectRole.parse(member.role.key),
    addedAt: member.addedAt.toISOString(),
  };
}

// Issue counts come from LabelsService (per label, by index), not a Prisma `_count`, which
// grouped every issue-label link in the database on each request (Phase 19).
type LabelRow = Prisma.LabelGetPayload<object>;

export function toLabel(label: LabelRow, issueCount: number): Label {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    issueCount,
  };
}
