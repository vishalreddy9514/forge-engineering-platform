import { isResolved, type IssueStatus, type UpdateIssueRequest } from '@forge/types';

import type { IssueEventType, Prisma } from '../generated/prisma/client';
import { toDateOnly } from './issue.mappers';

/** What an issue looked like before the update, as the diff needs it. */
export interface IssueSnapshot {
  title: string;
  description: string | null;
  type: string;
  status: IssueStatus;
  priority: string;
  assigneeId: string | null;
  storyPoints: number | null;
  dueDate: Date | null;
  labels: { id: string; name: string }[];
}

export interface Person {
  id: string;
  name: string;
}

export interface IssueChanges {
  /** Column updates (empty when nothing changed). */
  data: Prisma.IssueUncheckedUpdateManyInput;
  /** One history entry per changed field or label (FR-4.7). */
  events: { type: IssueEventType; field: string | null; oldValue: unknown; newValue: unknown }[];
  labels: { add: string[]; remove: string[] };
}

const SIMPLE_FIELDS = ['title', 'description', 'type', 'priority', 'storyPoints'] as const;

/**
 * Pure diff of an update against the current issue: which columns change, which history
 * events to record, and which labels to add or remove. Fields sent with their current value are
 * not changes, so a form that resubmits everything produces no noise.
 *
 * Assignee events store {id, name} snapshots, so the history reads correctly even after a user
 * is renamed or leaves the project.
 */
export function diffIssue(
  before: IssueSnapshot,
  input: Omit<UpdateIssueRequest, 'version'>,
  lookup: {
    assignees: { before: Person | null; after: Person | null };
    labelNames: Map<string, string>;
    now: Date;
  },
): IssueChanges {
  const data: Prisma.IssueUncheckedUpdateManyInput = {};
  const events: IssueChanges['events'] = [];
  const changed = (field: string, oldValue: unknown, newValue: unknown) => {
    events.push({ type: 'FIELD_CHANGED', field, oldValue, newValue });
  };

  for (const field of SIMPLE_FIELDS) {
    const next = input[field];
    if (next !== undefined && next !== before[field]) {
      data[field] = next as never;
      changed(field, before[field], next);
    }
  }

  if (input.status !== undefined && input.status !== before.status) {
    data.status = input.status;
    // resolved_at tracks terminal states (a CHECK constraint enforces it in the database).
    if (isResolved(input.status) !== isResolved(before.status)) {
      data.resolvedAt = isResolved(input.status) ? lookup.now : null;
    }
    changed('status', before.status, input.status);
  }

  if (input.assigneeId !== undefined && input.assigneeId !== before.assigneeId) {
    data.assigneeId = input.assigneeId;
    changed('assignee', lookup.assignees.before, lookup.assignees.after);
  }

  if (input.dueDate !== undefined && input.dueDate !== toDateOnly(before.dueDate)) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    changed('dueDate', toDateOnly(before.dueDate), input.dueDate);
  }

  const labels = { add: [] as string[], remove: [] as string[] };
  if (input.labelIds !== undefined) {
    const current = new Set(before.labels.map((l) => l.id));
    const next = new Set(input.labelIds);
    labels.add = input.labelIds.filter((id) => !current.has(id));
    labels.remove = before.labels.map((l) => l.id).filter((id) => !next.has(id));
    for (const id of labels.add) {
      events.push({
        type: 'LABEL_ADDED',
        field: 'labels',
        oldValue: null,
        newValue: { id, name: lookup.labelNames.get(id) ?? null },
      });
    }
    for (const label of before.labels.filter((l) => labels.remove.includes(l.id))) {
      events.push({ type: 'LABEL_REMOVED', field: 'labels', oldValue: label, newValue: null });
    }
  }

  return { data, events, labels };
}
