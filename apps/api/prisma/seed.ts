/**
 * Development seed: two projects with members, labels, three sprints (completed, active,
 * planned), realistic engineering issues with comments and history, and a few notifications.
 *
 *   pnpm --filter @forge/api db:seed      # seeds an empty database
 *   pnpm --filter @forge/api db:reset     # drops, re-migrates and re-seeds
 *
 * The data is written through the same rules the application uses (issue numbers from the
 * allocator, history events for every status change), so dashboards and burndown charts built
 * in later phases have something meaningful to show.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { hashPassword } from '../src/common/security/password-hasher';
import {
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  type Prisma,
  PrismaClient,
} from '../src/generated/prisma/client';
import { allocateIssueNumber } from '../src/issues/issue-number.allocator';

const ROLE = { PROJECT_MANAGER: 1, DEVELOPER: 2, VIEWER: 3 } as const;
const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (days: number, hour = 10) => {
  const date = new Date(now.getTime() - days * DAY);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
};
const dateOnly = (date: Date) => new Date(date.toISOString().slice(0, 10));

type UserKey = 'admin' | 'priya' | 'sam' | 'alex' | 'mei' | 'jordan';

const USERS: Record<UserKey, { email: string; displayName: string; isAdmin?: boolean }> = {
  admin: { email: 'admin@forge.local', displayName: 'Forge Admin', isAdmin: true },
  priya: { email: 'priya@forge.local', displayName: 'Priya Shah' },
  sam: { email: 'sam@forge.local', displayName: 'Sam Okafor' },
  alex: { email: 'alex@forge.local', displayName: 'Alex Novak' },
  mei: { email: 'mei@forge.local', displayName: 'Mei Tanaka' },
  jordan: { email: 'jordan@forge.local', displayName: 'Jordan Reyes' },
};

interface SeedIssue {
  title: string;
  description: string;
  type: IssueType;
  priority: IssuePriority;
  status: IssueStatus;
  points?: number;
  assignee?: UserKey;
  reporter: UserKey;
  labels: string[];
  /** Which sprint the issue is in (or finished in); undefined = backlog. */
  sprint?: 'previous' | 'current' | 'next';
  /** Days after the sprint started that the issue reached DONE (burndown shape). */
  doneOnDay?: number;
  /** Was in the previous sprint, not finished, carried into the current one. */
  carriedOver?: boolean;
  comments?: [UserKey, string][];
}

const PAYMENTS_ISSUES: SeedIssue[] = [
  {
    title: 'Stripe webhook retries can double-charge customers',
    description:
      'When our webhook handler times out, Stripe retries `payment_intent.succeeded`. The handler is not idempotent, so a slow first attempt followed by a retry creates two ledger entries and sends two receipts.\n\n**Fix direction:** store the Stripe event ID with a unique constraint and skip already-processed events.',
    type: 'BUG',
    priority: 'CRITICAL',
    status: 'DONE',
    points: 5,
    assignee: 'sam',
    reporter: 'priya',
    labels: ['bug', 'payments', 'incident'],
    sprint: 'previous',
    doneOnDay: 4,
    comments: [
      ['sam', 'Reproduced locally by adding a 35s sleep: two ledger rows for one event.'],
      ['priya', 'This caused the payment service incident on the 3rd. Linking the postmortem.'],
      [
        'sam',
        'Fixed with a `processed_stripe_events` table keyed on event ID. Added a regression test.',
      ],
    ],
  },
  {
    title: 'Add idempotency keys to POST /payments',
    description:
      'Clients retrying on network errors can create duplicate payments. Accept an `Idempotency-Key` header, persist the first response for 24h and replay it for repeats.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'DONE',
    points: 8,
    assignee: 'alex',
    reporter: 'priya',
    labels: ['payments', 'api'],
    sprint: 'previous',
    doneOnDay: 9,
  },
  {
    title: 'Refund endpoint returns 500 for partially captured payments',
    description:
      'Refunding a payment that was captured in two parts fails with a 500. The refund amount validation assumes a single capture.',
    type: 'BUG',
    priority: 'HIGH',
    status: 'DONE',
    points: 3,
    assignee: 'mei',
    reporter: 'sam',
    labels: ['bug', 'payments'],
    sprint: 'previous',
    doneOnDay: 6,
  },
  {
    title: 'Migrate currency amounts from float to integer minor units',
    description:
      'Several services store money as floating point. Move to integer minor units (pence/cents) with an explicit currency code to remove rounding errors.',
    type: 'TASK',
    priority: 'HIGH',
    status: 'IN_PROGRESS',
    points: 13,
    assignee: 'alex',
    reporter: 'priya',
    labels: ['payments', 'tech-debt'],
    sprint: 'current',
    carriedOver: true,
    comments: [['alex', 'Ledger and invoices done. Reporting service still reads floats.']],
  },
  {
    title: 'Payment reconciliation job times out at month end',
    description:
      'The nightly reconciliation job exceeds its 30 minute limit on the last day of the month when transaction volume triples. It loads every transaction into memory.',
    type: 'BUG',
    priority: 'HIGH',
    status: 'IN_REVIEW',
    points: 5,
    assignee: 'sam',
    reporter: 'mei',
    labels: ['bug', 'performance'],
    sprint: 'current',
  },
  {
    title: 'Expose payment status webhooks to merchants',
    description:
      'Merchants poll GET /payments/:id for status. Send signed webhooks on status changes with retries and a delivery log.',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'DONE',
    points: 8,
    assignee: 'mei',
    reporter: 'priya',
    labels: ['payments', 'api'],
    sprint: 'current',
    doneOnDay: 3,
  },
  {
    title: 'Add p95 latency alert for checkout API',
    description: 'Alert when checkout p95 latency exceeds 800 ms for 10 minutes.',
    type: 'TASK',
    priority: 'MEDIUM',
    status: 'TODO',
    points: 2,
    assignee: 'sam',
    reporter: 'priya',
    labels: ['observability'],
    sprint: 'current',
  },
  {
    title: 'Card decline messages are not localised',
    description:
      'Decline reasons from the card processor are shown to customers in English regardless of locale.',
    type: 'BUG',
    priority: 'LOW',
    status: 'TODO',
    points: 3,
    reporter: 'jordan',
    labels: ['bug', 'frontend'],
    sprint: 'current',
  },
  {
    title: 'Support Apple Pay on the web checkout',
    description: 'Add Apple Pay via Stripe Payment Request Button, behind a feature flag.',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'TODO',
    points: 8,
    reporter: 'priya',
    labels: ['payments', 'frontend'],
    sprint: 'next',
  },
  {
    title: 'Remove deprecated v1 payments endpoints',
    description: 'v1 traffic is below 0.1% for 60 days. Remove the endpoints and their tests.',
    type: 'CHORE',
    priority: 'LOW',
    status: 'BACKLOG',
    points: 3,
    reporter: 'alex',
    labels: ['tech-debt', 'api'],
  },
  {
    title: 'Investigate intermittent 502s from the fraud-check service',
    description:
      'About 0.3% of checkout requests get a 502 from fraud-check between 02:00 and 03:00 UTC, which coincides with its nightly model reload.',
    type: 'BUG',
    priority: 'MEDIUM',
    status: 'BACKLOG',
    reporter: 'mei',
    labels: ['bug', 'incident'],
  },
  {
    title: 'Evaluate moving settlement files from SFTP to S3',
    description: 'Partner banks now support S3 delivery. Evaluate cost, security and effort.',
    type: 'TASK',
    priority: 'LOW',
    status: 'CANCELLED',
    reporter: 'priya',
    labels: ['tech-debt'],
    comments: [['priya', 'Only one partner supports it today. Revisit next quarter.']],
  },
];

const IDENTITY_ISSUES: SeedIssue[] = [
  {
    title: 'Users cannot reset their password',
    description:
      'Password reset emails are not delivered for addresses containing a plus sign (e.g. `name+tag@example.com`). The address is URL-encoded twice when building the reset link.',
    type: 'BUG',
    priority: 'CRITICAL',
    status: 'IN_PROGRESS',
    points: 3,
    assignee: 'alex',
    reporter: 'jordan',
    labels: ['bug', 'auth'],
    comments: [
      ['jordan', 'Three support tickets about this today.'],
      ['alex', 'Found it: `encodeURIComponent` applied in both the mailer and the template.'],
    ],
  },
  {
    title: 'Add TOTP two-factor authentication',
    description:
      'Allow users to enrol an authenticator app. Require the second factor on login and when changing the password. Provide one-time recovery codes.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'TODO',
    points: 13,
    assignee: 'mei',
    reporter: 'priya',
    labels: ['auth', 'security'],
  },
  {
    title: 'Session tokens are not revoked when a user is deactivated',
    description:
      'Deactivating a user blocks new logins, but existing refresh tokens keep working until they expire. Revoke all token families on deactivation.',
    type: 'BUG',
    priority: 'HIGH',
    status: 'IN_REVIEW',
    points: 2,
    assignee: 'sam',
    reporter: 'priya',
    labels: ['bug', 'auth', 'security'],
  },
  {
    title: 'Rate-limit the login endpoint per account and per IP',
    description: 'Progressive delay after 5 failed attempts, tracked in Redis.',
    type: 'TASK',
    priority: 'HIGH',
    status: 'DONE',
    points: 5,
    assignee: 'alex',
    reporter: 'priya',
    labels: ['auth', 'security'],
  },
  {
    title: 'Support "Sign in with GitHub"',
    description: 'OAuth login for users whose email is verified on GitHub.',
    type: 'FEATURE',
    priority: 'LOW',
    status: 'BACKLOG',
    reporter: 'sam',
    labels: ['auth'],
  },
];

const LABELS: Record<string, string> = {
  bug: '#d73a4a',
  payments: '#0e8a16',
  api: '#1d76db',
  incident: '#b60205',
  'tech-debt': '#fbca04',
  performance: '#5319e7',
  observability: '#0052cc',
  frontend: '#c5def5',
  auth: '#006b75',
  security: '#e99695',
};

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    if ((await prisma.project.count()) > 0) {
      console.log('Database already has data; skipping. Use `pnpm db:reset` to start over.');
      return;
    }
    // One transaction: a failure leaves the database empty rather than half-seeded.
    await prisma.$transaction((tx) => seed(tx), { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
  }
}

async function seed(prisma: Prisma.TransactionClient): Promise<void> {
  const password = process.env.SEED_USER_PASSWORD ?? 'forge-demo-password';
  const passwordHash = await hashPassword(password);

  const users = {} as Record<UserKey, string>;
  for (const [key, user] of Object.entries(USERS) as [UserKey, (typeof USERS)[UserKey]][]) {
    const created = await prisma.user.create({
      data: { ...user, passwordHash, createdAt: daysAgo(60) },
    });
    users[key] = created.id;
  }

  const payments = await createProject(prisma, users, {
    key: 'PAY',
    name: 'Payments Platform',
    description: 'Checkout, payment processing, refunds and reconciliation.',
    lead: 'priya',
    members: {
      sam: ROLE.DEVELOPER,
      alex: ROLE.DEVELOPER,
      mei: ROLE.DEVELOPER,
      jordan: ROLE.VIEWER,
    },
  });
  const identity = await createProject(prisma, users, {
    key: 'AUTH',
    name: 'Identity & Access',
    description: 'Login, sessions, password reset and two-factor authentication.',
    lead: 'priya',
    members: {
      sam: ROLE.DEVELOPER,
      alex: ROLE.DEVELOPER,
      mei: ROLE.DEVELOPER,
      jordan: ROLE.DEVELOPER,
    },
  });

  // Payments runs two-week sprints: one finished, one in progress (day 6), one planned.
  const sprints = {
    previous: await prisma.sprint.create({
      data: {
        projectId: payments.id,
        name: 'PAY Sprint 1',
        goal: 'Stop duplicate charges',
        status: 'COMPLETED',
        startDate: dateOnly(daysAgo(20)),
        endDate: dateOnly(daysAgo(7)),
        startedAt: daysAgo(20, 9),
        completedAt: daysAgo(6, 17),
      },
    }),
    current: await prisma.sprint.create({
      data: {
        projectId: payments.id,
        name: 'PAY Sprint 2',
        goal: 'Money correctness and merchant webhooks',
        status: 'ACTIVE',
        startDate: dateOnly(daysAgo(6)),
        endDate: dateOnly(daysAgo(-7)),
        startedAt: daysAgo(6, 9),
      },
    }),
    next: await prisma.sprint.create({
      data: {
        projectId: payments.id,
        name: 'PAY Sprint 3',
        status: 'PLANNED',
        startDate: dateOnly(daysAgo(-8)),
        endDate: dateOnly(daysAgo(-21)),
      },
    }),
  };

  let issueCount = 0;
  for (const issue of PAYMENTS_ISSUES) {
    await createIssue(prisma, users, payments, issue, sprints);
    issueCount++;
  }
  for (const issue of IDENTITY_ISSUES) {
    await createIssue(prisma, users, identity, issue, sprints);
    issueCount++;
  }

  // Same payload shape the notifications worker writes (NotificationPayload in @forge/types).
  await prisma.notification.create({
    data: {
      userId: users.sam,
      type: 'ISSUE_ASSIGNED',
      payload: {
        projectKey: 'PAY',
        issueKey: 'PAY-5',
        issueTitle: 'Payment reconciliation job times out at month end',
        actorName: 'Mei Tanaka',
      },
      createdAt: daysAgo(5),
    },
  });
  await prisma.notification.create({
    data: {
      userId: users.alex,
      type: 'SPRINT_STARTED',
      payload: {
        projectKey: 'PAY',
        sprintId: sprints.current.id,
        sprintName: 'PAY Sprint 2',
        actorName: 'Priya Shah',
      },
      createdAt: daysAgo(6, 9),
    },
  });

  console.log(
    `Seeded ${Object.keys(users).length} users, 2 projects, 3 sprints and ${issueCount} issues.\n` +
      `Log in as any of: ${Object.values(USERS)
        .map((u) => u.email)
        .join(', ')}\n` +
      `Password: ${password === 'forge-demo-password' ? 'forge-demo-password (dev default)' : '(from SEED_USER_PASSWORD)'}`,
  );
}

async function createProject(
  prisma: Prisma.TransactionClient,
  users: Record<UserKey, string>,
  spec: {
    key: string;
    name: string;
    description: string;
    lead: UserKey;
    members: Partial<Record<UserKey, number>>;
  },
) {
  const project = await prisma.project.create({
    data: {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      createdById: users[spec.lead],
      createdAt: daysAgo(45),
      members: {
        create: [
          { userId: users[spec.lead], roleId: ROLE.PROJECT_MANAGER },
          ...Object.entries(spec.members).map(([key, roleId]) => ({
            userId: users[key as UserKey],
            roleId,
            addedById: users[spec.lead],
          })),
        ],
      },
      labels: {
        create: Object.entries(LABELS).map(([name, color]) => ({ name, color })),
      },
    },
    include: { labels: true },
  });
  return project;
}

async function createIssue(
  tx: Prisma.TransactionClient,
  users: Record<UserKey, string>,
  project: { id: string; labels: { id: string; name: string }[] },
  spec: SeedIssue,
  sprints: Record<'previous' | 'current' | 'next', { id: string; startedAt: Date | null }>,
): Promise<void> {
  const sprint = spec.sprint ? sprints[spec.sprint] : undefined;
  const sprintStart = sprint?.startedAt ?? daysAgo(25);
  const createdAt = spec.carriedOver ? daysAgo(22) : new Date(sprintStart.getTime() - 2 * DAY);
  const terminal = spec.status === 'DONE' || spec.status === 'CANCELLED';
  const resolvedAt = terminal
    ? new Date(sprintStart.getTime() + (spec.doneOnDay ?? 1) * DAY + 3 * 60 * 60 * 1000)
    : null;

  const number = await allocateIssueNumber(tx, project.id);
  const reporterId = users[spec.reporter];
  const assigneeId = spec.assignee ? users[spec.assignee] : null;

  const issue = await tx.issue.create({
    data: {
      projectId: project.id,
      number,
      title: spec.title,
      description: spec.description,
      type: spec.type,
      priority: spec.priority,
      status: spec.status,
      storyPoints: spec.points ?? null,
      reporterId,
      assigneeId,
      resolvedAt,
      createdAt,
      updatedAt: resolvedAt ?? createdAt,
    },
  });

  await tx.issueLabel.createMany({
    data: spec.labels.map((name) => {
      const label = project.labels.find((l) => l.name === name);
      if (!label) throw new Error(`Unknown label ${name}`);
      return { issueId: issue.id, labelId: label.id, projectId: project.id };
    }),
  });

  // History: created, then the status path to where the issue is now.
  const events: Prisma.IssueEventCreateManyInput[] = [
    { issueId: issue.id, actorId: reporterId, type: 'CREATED', createdAt },
  ];
  const path = statusPath(spec.status);
  path.forEach((status, index) => {
    const at =
      index === path.length - 1 && resolvedAt
        ? resolvedAt
        : new Date(sprintStart.getTime() + (index + 1) * 0.5 * DAY);
    events.push({
      issueId: issue.id,
      actorId: assigneeId ?? reporterId,
      type: 'FIELD_CHANGED',
      field: 'status',
      oldValue: index === 0 ? 'BACKLOG' : path[index - 1],
      newValue: status,
      createdAt: at,
    });
  });
  await tx.issueEvent.createMany({ data: events });

  for (const [i, [author, body]] of (spec.comments ?? []).entries()) {
    await tx.issueComment.create({
      data: {
        issueId: issue.id,
        authorId: users[author],
        body,
        createdAt: new Date(createdAt.getTime() + (i + 1) * 0.7 * DAY),
      },
    });
  }

  // Sprint membership, including the carried-over history row.
  const base = {
    issueId: issue.id,
    projectId: project.id,
    storyPointsAtAdd: spec.points ?? null,
  };
  if (spec.carriedOver) {
    await tx.sprintIssue.create({
      data: {
        ...base,
        sprintId: sprints.previous.id,
        addedAt: daysAgo(20, 9),
        removedAt: daysAgo(6, 17),
        outcome: 'CARRIED_OVER',
      },
    });
  }
  if (sprint) {
    const finishedPrevious = spec.sprint === 'previous';
    await tx.sprintIssue.create({
      data: {
        ...base,
        sprintId: sprint.id,
        addedAt: spec.carriedOver ? daysAgo(6, 9) : sprintStart,
        removedAt: finishedPrevious ? daysAgo(6, 17) : null,
        outcome: finishedPrevious ? 'COMPLETED' : null,
      },
    });
  }
}

/** Statuses an issue passed through after BACKLOG to reach `status`. */
function statusPath(status: IssueStatus): IssueStatus[] {
  switch (status) {
    case 'BACKLOG':
      return [];
    case 'TODO':
      return ['TODO'];
    case 'IN_PROGRESS':
      return ['TODO', 'IN_PROGRESS'];
    case 'IN_REVIEW':
      return ['TODO', 'IN_PROGRESS', 'IN_REVIEW'];
    case 'DONE':
      return ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
    case 'CANCELLED':
      return ['CANCELLED'];
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
