import { type IssueEvent, PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '@forge/types';

const FIELD_NAMES: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  type: 'the type',
  status: 'the status',
  priority: 'the priority',
  assignee: 'the assignee',
  storyPoints: 'the story points',
  dueDate: 'the due date',
};

const ENUM_LABELS: Record<string, Record<string, string | undefined> | undefined> = {
  status: STATUS_LABELS,
  priority: PRIORITY_LABELS,
  type: TYPE_LABELS,
};

const nameOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'name' in value && typeof value.name === 'string'
    ? value.name
    : null;

/** A stored history value as display text. Values are JSON snapshots, so every shape is checked. */
function display(field: string | null, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'string') {
    const labels = ENUM_LABELS[field ?? ''];
    return labels?.[value] ?? value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return nameOf(value) ?? 'a value';
}

/** One history entry as a sentence fragment, following the actor's name: "changed the status…". */
export function describeEvent(
  event: Pick<IssueEvent, 'type' | 'field' | 'oldValue' | 'newValue'>,
): string {
  switch (event.type) {
    case 'CREATED':
      return 'created the issue';
    case 'DELETED':
      return 'deleted the issue';
    case 'RESTORED':
      return 'restored the issue';
    case 'COMMENT_ADDED':
      return 'commented';
    case 'COMMENT_EDITED':
      return 'edited a comment';
    case 'COMMENT_DELETED':
      return 'deleted a comment';
    case 'LABEL_ADDED':
      return `added the label ${nameOf(event.newValue) ?? '(deleted label)'}`;
    case 'LABEL_REMOVED':
      return `removed the label ${nameOf(event.oldValue) ?? '(deleted label)'}`;
    case 'FIELD_CHANGED': {
      const field = event.field ?? '';
      const name = FIELD_NAMES[field] ?? field;
      // Long text is summarised; the current version is on the page.
      if (field === 'description') return 'updated the description';
      return `changed ${name} from ${display(field, event.oldValue)} to ${display(field, event.newValue)}`;
    }
    default:
      return event.type.toLowerCase().replaceAll('_', ' ');
  }
}
