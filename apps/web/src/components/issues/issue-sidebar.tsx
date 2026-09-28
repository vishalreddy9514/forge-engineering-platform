'use client';

import {
  canTransition,
  type IssueDetail,
  IssuePriority,
  IssueStatus,
  IssueType,
  type Label as ProjectLabel,
  type ProjectMember,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  type UpdateIssueRequest,
} from '@forge/types';
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { type ReactNode, useState } from 'react';

import { LabelChips } from './issue-badges';

type Change = Omit<UpdateIssueRequest, 'version'>;

interface IssueSidebarProps {
  issue: IssueDetail;
  members: ProjectMember[];
  labels: ProjectLabel[];
  canEdit: boolean;
  onChange: (change: Change) => void;
}

/** The statuses an issue can move to from its current one, current first. */
export function statusOptions(status: IssueStatus): IssueStatus[] {
  return [
    status,
    ...IssueStatus.options.filter((to) => to !== status && canTransition(status, to)),
  ];
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * Issue fields. Each control saves on change with the version the page last loaded, so a
 * concurrent edit by someone else surfaces as a conflict rather than being overwritten.
 */
export function IssueSidebar({ issue, members, labels, canEdit, onChange }: IssueSidebarProps) {
  const [points, setPoints] = useState(issue.storyPoints?.toString() ?? '');
  const [pointsFor, setPointsFor] = useState(issue.storyPoints);
  // Re-sync the draft when the saved value changes (after a save or a refetch).
  if (pointsFor !== issue.storyPoints) {
    setPointsFor(issue.storyPoints);
    setPoints(issue.storyPoints?.toString() ?? '');
  }

  const savePoints = () => {
    const value = points.trim() === '' ? null : Number(points);
    if (value === issue.storyPoints) return;
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
      setPoints(issue.storyPoints?.toString() ?? '');
      return;
    }
    onChange({ storyPoints: value });
  };

  const selectedLabels = new Set(issue.labels.map((l) => l.id));
  const toggleLabel = (id: string) => {
    const next = new Set(selectedLabels);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ labelIds: [...next] });
  };

  // A former member can still be the assignee; keep them selectable so the value renders.
  const assignable = members.map((m) => m.user);
  if (issue.assignee && !assignable.some((u) => u.id === issue.assignee?.id)) {
    assignable.push(issue.assignee);
  }

  return (
    <aside aria-label="Issue details" className="grid content-start gap-4 rounded-xl border p-4">
      <Field id="issue-status" label="Status">
        <Select
          id="issue-status"
          value={issue.status}
          disabled={!canEdit}
          onChange={(e) => {
            onChange({ status: e.target.value as IssueStatus });
          }}
        >
          {statusOptions(issue.status).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="issue-priority" label="Priority">
        <Select
          id="issue-priority"
          value={issue.priority}
          disabled={!canEdit}
          onChange={(e) => {
            onChange({ priority: e.target.value as IssuePriority });
          }}
        >
          {IssuePriority.options.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="issue-type" label="Type">
        <Select
          id="issue-type"
          value={issue.type}
          disabled={!canEdit}
          onChange={(e) => {
            onChange({ type: e.target.value as IssueType });
          }}
        >
          {IssueType.options.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="issue-assignee" label="Assignee">
        <Select
          id="issue-assignee"
          value={issue.assignee?.id ?? ''}
          disabled={!canEdit}
          onChange={(e) => {
            onChange({ assigneeId: e.target.value || null });
          }}
        >
          <option value="">Unassigned</option>
          {assignable.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="issue-points" label="Story points">
        <Input
          id="issue-points"
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={points}
          disabled={!canEdit}
          onChange={(e) => {
            setPoints(e.target.value);
          }}
          onBlur={savePoints}
          onKeyDown={(e) => {
            if (e.key === 'Enter') savePoints();
          }}
        />
      </Field>

      <Field id="issue-due" label="Due date">
        <Input
          id="issue-due"
          type="date"
          value={issue.dueDate ?? ''}
          disabled={!canEdit}
          onChange={(e) => {
            onChange({ dueDate: e.target.value || null });
          }}
        />
      </Field>

      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Labels</legend>
        {canEdit ? (
          labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">This project has no labels yet.</p>
          ) : (
            labels.map((label) => (
              <label key={label.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedLabels.has(label.id)}
                  onChange={() => {
                    toggleLabel(label.id);
                  }}
                />
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </label>
            ))
          )
        ) : issue.labels.length > 0 ? (
          <LabelChips labels={issue.labels} />
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </fieldset>

      <dl className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <dt>Sprint</dt>
          <dd>{issue.sprint?.name ?? 'Backlog'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Reporter</dt>
          <dd>{issue.reporter.displayName}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd>{new Date(issue.createdAt).toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Updated</dt>
          <dd>{new Date(issue.updatedAt).toLocaleString()}</dd>
        </div>
        {issue.resolvedAt && (
          <div className="flex justify-between gap-2">
            <dt>Resolved</dt>
            <dd>{new Date(issue.resolvedAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>
    </aside>
  );
}
