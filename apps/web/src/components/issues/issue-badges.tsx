import {
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  type LabelChip,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  type UserSummary,
} from '@forge/types';
import { cn } from '@forge/ui/lib/utils';
import {
  ArrowDown,
  ArrowUp,
  Bug,
  CheckSquare,
  ChevronsUp,
  Equal,
  Sparkles,
  Wrench,
} from 'lucide-react';

const STATUS_STYLES: Record<IssueStatus, string> = {
  BACKLOG: 'bg-muted text-muted-foreground',
  TODO: 'bg-secondary text-secondary-foreground',
  IN_PROGRESS: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  IN_REVIEW: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  DONE: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  CANCELLED: 'bg-muted text-muted-foreground line-through',
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span
      className={cn(
        'inline-flex rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_STYLES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_ICONS = { CRITICAL: ChevronsUp, HIGH: ArrowUp, MEDIUM: Equal, LOW: ArrowDown };
const PRIORITY_COLOURS: Record<IssuePriority, string> = {
  CRITICAL: 'text-destructive',
  HIGH: 'text-orange-600',
  MEDIUM: 'text-muted-foreground',
  LOW: 'text-blue-600',
};

/** Icon + accessible name; the colour is decoration, never the only signal. */
export function PriorityIcon({
  priority,
  withLabel,
}: {
  priority: IssuePriority;
  withLabel?: boolean;
}) {
  const Icon = PRIORITY_ICONS[priority];
  return (
    <span
      className="inline-flex items-center gap-1 text-sm"
      title={`${PRIORITY_LABELS[priority]} priority`}
    >
      <Icon className={cn('size-4', PRIORITY_COLOURS[priority])} aria-hidden="true" />
      <span className={withLabel ? undefined : 'sr-only'}>{PRIORITY_LABELS[priority]}</span>
    </span>
  );
}

const TYPE_ICONS = { BUG: Bug, FEATURE: Sparkles, TASK: CheckSquare, CHORE: Wrench };

export function TypeIcon({ type, withLabel }: { type: IssueType; withLabel?: boolean }) {
  const Icon = TYPE_ICONS[type];
  return (
    <span className="inline-flex items-center gap-1 text-sm" title={TYPE_LABELS[type]}>
      <Icon
        className={cn('size-4', type === 'BUG' ? 'text-destructive' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className={withLabel ? undefined : 'sr-only'}>{TYPE_LABELS[type]}</span>
    </span>
  );
}

export function LabelChips({ labels }: { labels: LabelChip[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label.id}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs"
        >
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ backgroundColor: label.color }}
          />
          {label.name}
        </span>
      ))}
    </span>
  );
}

export function Avatar({ user, size = 'sm' }: { user: UserSummary | null; size?: 'sm' | 'md' }) {
  const initials = user
    ? user.displayName
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?';
  return (
    <span
      title={user ? user.displayName : 'Unassigned'}
      aria-label={user ? user.displayName : 'Unassigned'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium',
        user
          ? 'bg-secondary text-secondary-foreground'
          : 'border border-dashed text-muted-foreground',
        size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
      )}
    >
      {initials}
    </span>
  );
}
