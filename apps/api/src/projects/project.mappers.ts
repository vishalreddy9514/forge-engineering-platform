import type {
  Label,
  ProjectDetail,
  ProjectMember,
  ProjectSummary,
  UserSummary,
} from '@forge/types';
import { ProjectRole } from '@forge/types';

import type { EffectiveRole } from '../access-control/permissions';
import type { Prisma } from '../generated/prisma/client';

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

const OPEN_ISSUES: Prisma.IssueWhereInput = {
  deletedAt: null,
  status: { notIn: ['DONE', 'CANCELLED'] },
};

/** Everything a project card needs, in one query (counts included). */
export const projectSummaryInclude = (userId: string) =>
  ({
    members: { where: { userId }, select: { role: { select: { key: true } } } },
    _count: { select: { members: true, issues: { where: OPEN_ISSUES } } },
  }) as const satisfies Prisma.ProjectInclude;

type SummaryRow = Prisma.ProjectGetPayload<{
  include: ReturnType<typeof projectSummaryInclude>;
}>;

export function toProjectSummary(project: SummaryRow): ProjectSummary {
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
    memberCount: project._count.members,
    openIssueCount: project._count.issues,
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

export function toProjectDetail(project: DetailRow): ProjectDetail {
  const sprint = project.sprints[0];
  return {
    ...toProjectSummary(project),
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

export const LABEL_INCLUDE = { _count: { select: { issues: true } } } as const;
type LabelRow = Prisma.LabelGetPayload<{ include: typeof LABEL_INCLUDE }>;

export function toLabel(label: LabelRow): Label {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    issueCount: label._count.issues,
  };
}
