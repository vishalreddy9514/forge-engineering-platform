import { describeEvent } from './issue-events';

const event = (type: string, field: string | null, oldValue: unknown, newValue: unknown) => ({
  type,
  field,
  oldValue,
  newValue,
});

describe('describeEvent', () => {
  it('uses display labels for workflow fields', () => {
    expect(describeEvent(event('FIELD_CHANGED', 'status', 'IN_PROGRESS', 'DONE'))).toBe(
      'changed the status from In progress to Done',
    );
    expect(describeEvent(event('FIELD_CHANGED', 'priority', 'LOW', 'CRITICAL'))).toBe(
      'changed the priority from Low to Critical',
    );
  });

  it('names people and labels from their snapshots', () => {
    expect(
      describeEvent(event('FIELD_CHANGED', 'assignee', null, { id: 'x', name: 'Dev Patel' })),
    ).toBe('changed the assignee from none to Dev Patel');
    expect(describeEvent(event('LABEL_ADDED', 'labels', null, { id: 'l', name: 'backend' }))).toBe(
      'added the label backend',
    );
    expect(describeEvent(event('LABEL_REMOVED', 'labels', { id: 'l', name: null }, null))).toBe(
      'removed the label (deleted label)',
    );
  });

  it('summarises descriptions and handles numbers and dates', () => {
    expect(describeEvent(event('FIELD_CHANGED', 'description', 'a', 'b'))).toBe(
      'updated the description',
    );
    expect(describeEvent(event('FIELD_CHANGED', 'storyPoints', null, 5))).toBe(
      'changed the story points from none to 5',
    );
    expect(describeEvent(event('FIELD_CHANGED', 'dueDate', '2026-10-01', null))).toBe(
      'changed the due date from 2026-10-01 to none',
    );
  });

  it('names attachments', () => {
    expect(
      describeEvent(event('ATTACHMENT_ADDED', null, null, { id: 'a', name: 'trace.log' })),
    ).toBe('attached trace.log');
    expect(describeEvent(event('ATTACHMENT_REMOVED', null, { id: 'a', name: 'x.png' }, null))).toBe(
      'removed the attachment x.png',
    );
  });

  it('falls back to readable text for event types it does not know', () => {
    expect(describeEvent(event('CREATED', null, null, {}))).toBe('created the issue');
    expect(describeEvent(event('SPRINT_CHANGED', null, null, null))).toBe('sprint changed');
  });
});
