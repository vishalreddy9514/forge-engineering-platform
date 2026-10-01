import { oneDecimal, weekSeries, weekStart } from './weeks';

describe('weeks', () => {
  it('starts weeks on Monday in UTC', () => {
    expect(weekStart(new Date('2026-10-01T12:00:00Z'))).toBe('2026-09-28'); // Thursday
    expect(weekStart(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28'); // Monday
    expect(weekStart(new Date('2026-10-04T23:59:59Z'))).toBe('2026-09-28'); // Sunday
    expect(weekStart(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05');
  });

  it('crosses month and year boundaries', () => {
    expect(weekStart(new Date('2027-01-01T08:00:00Z'))).toBe('2026-12-28');
  });

  it('lists the last weeks oldest first, ending with the current one', () => {
    expect(weekSeries(new Date('2026-10-01T12:00:00Z'), 3)).toEqual([
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(weekSeries(new Date('2026-10-01T12:00:00Z'), 1)).toEqual(['2026-09-28']);
  });

  it('rounds to one decimal and keeps null', () => {
    expect(oneDecimal(26.25)).toBe(26.3);
    expect(oneDecimal(0)).toBe(0);
    expect(oneDecimal(null)).toBeNull();
  });
});
