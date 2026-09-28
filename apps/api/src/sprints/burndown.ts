import type { Burndown } from '@forge/types';

const DAY_MS = 86_400_000;
const RESOLVED = new Set(['DONE', 'CANCELLED']);

export interface Membership {
  issueId: string;
  addedAt: Date;
  removedAt: Date | null;
  outcome: 'COMPLETED' | 'CARRIED_OVER' | 'REMOVED' | null;
}

export interface IssueState {
  status: string;
  storyPoints: number | null;
}

/** A status or story-point change, from the issue's history. */
export interface FieldChange {
  issueId: string;
  field: 'status' | 'storyPoints';
  oldValue: unknown;
  newValue: unknown;
  at: Date;
}

export interface BurndownInput {
  sprintId: string;
  startDate: string;
  endDate: string;
  startedAt: Date | null;
  completedAt: Date | null;
  now: Date;
  memberships: Membership[];
  /** Current state of every issue that was ever in the sprint. */
  issues: ReadonlyMap<string, IssueState>;
  /** Status and story-point changes for those issues, in any order. */
  changes: FieldChange[];
}

/**
 * Remaining points per day (FR-5.5), reconstructed from history rather than nightly snapshots,
 * so it is correct for any past sprint and never misses a day.
 *
 * For each day, the state is taken at the end of that day (UTC), or at completion if the sprint
 * ended that day. An issue counts while it belongs to the sprint and is not Done or Cancelled;
 * its points and status are those in effect at that moment.
 */
export function computeBurndown(input: BurndownInput): Burndown {
  const history = new Map<string, FieldChange[]>();
  for (const change of [...input.changes].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const list = history.get(change.issueId) ?? [];
    list.push(change);
    history.set(change.issueId, list);
  }

  const valueAt = (issueId: string, field: FieldChange['field'], at: Date): unknown => {
    const changes = (history.get(issueId) ?? []).filter((c) => c.field === field);
    const before = changes.filter((c) => c.at <= at).at(-1);
    if (before) return before.newValue;
    // No change yet: the value is whatever the first later change started from.
    const after = changes.find((c) => c.at > at);
    if (after) return after.oldValue;
    const current = input.issues.get(issueId);
    return field === 'status' ? current?.status : current?.storyPoints;
  };
  const pointsAt = (issueId: string, at: Date) => {
    const value = valueAt(issueId, 'storyPoints', at);
    return typeof value === 'number' ? value : 0;
  };
  const isMember = (m: Membership, at: Date) => {
    if (m.addedAt > at) return false;
    if (m.removedAt === null || m.removedAt > at) return true;
    // Issues still in the sprint when it completed count until the very end.
    return m.outcome !== 'REMOVED' && at.getTime() === m.removedAt.getTime();
  };
  const remainingAt = (at: Date) =>
    input.memberships
      .filter((m) => isMember(m, at))
      .filter((m) => !RESOLVED.has(String(valueAt(m.issueId, 'status', at))))
      .reduce((sum, m) => sum + pointsAt(m.issueId, at), 0);

  const first = Date.parse(`${input.startDate}T00:00:00Z`);
  const last = Date.parse(`${input.endDate}T00:00:00Z`);
  const dayCount = Math.round((last - first) / DAY_MS) + 1;

  if (!input.startedAt) {
    // Not started: the plan is everything currently in it; nothing has burned down yet.
    const committed = input.memberships
      .filter((m) => m.removedAt === null)
      .reduce((sum, m) => sum + (input.issues.get(m.issueId)?.storyPoints ?? 0), 0);
    return {
      sprintId: input.sprintId,
      startDate: input.startDate,
      endDate: input.endDate,
      committed,
      days: Array.from({ length: dayCount }, (_, i) => ({
        date: new Date(first + i * DAY_MS).toISOString().slice(0, 10),
        remaining: null,
        ideal: ideal(committed, i, dayCount),
        scopeChange: 0,
      })),
    };
  }

  const startedAt = input.startedAt;
  const committed = remainingAt(startedAt);
  const cutoff = input.completedAt ?? input.now;

  const days = Array.from({ length: dayCount }, (_, i) => {
    const dayStart = first + i * DAY_MS;
    const dayEnd = new Date(dayStart + DAY_MS - 1);
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const future = dayStart > cutoff.getTime();
    const at = dayEnd < cutoff ? dayEnd : cutoff;

    // Scope change: issues added after the sprint started, or removed from it, that day.
    let scopeChange = 0;
    for (const m of input.memberships) {
      if (m.addedAt > startedAt && inDay(m.addedAt, dayStart)) {
        scopeChange += pointsAt(m.issueId, m.addedAt);
      }
      if (m.outcome === 'REMOVED' && m.removedAt && inDay(m.removedAt, dayStart)) {
        scopeChange -= pointsAt(m.issueId, m.removedAt);
      }
    }
    return {
      date,
      remaining: future ? null : remainingAt(at),
      ideal: ideal(committed, i, dayCount),
      scopeChange: future ? 0 : scopeChange,
    };
  });

  return {
    sprintId: input.sprintId,
    startDate: input.startDate,
    endDate: input.endDate,
    committed,
    days,
  };
}

function inDay(at: Date, dayStart: number): boolean {
  const t = at.getTime();
  return t >= dayStart && t < dayStart + DAY_MS;
}

/** Straight line from `committed` on the first day to zero on the last, one decimal place. */
function ideal(committed: number, index: number, dayCount: number): number {
  if (dayCount <= 1) return 0;
  return Math.round(committed * (1 - index / (dayCount - 1)) * 10) / 10;
}
