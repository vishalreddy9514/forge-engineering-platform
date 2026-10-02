const DAY = 24 * 60 * 60 * 1000;

/** The Monday (UTC) of the week `date` falls in, as YYYY-MM-DD; matches Postgres date_trunc. */
export function weekStart(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY).toISOString().slice(0, 10);
}

/** The Mondays of the last `count` weeks, the current one last. */
export function weekSeries(now: Date, count: number): string[] {
  const current = Date.parse(weekStart(now));
  return Array.from({ length: count }, (_, i) =>
    new Date(current - (count - 1 - i) * 7 * DAY).toISOString().slice(0, 10),
  );
}

/** Rounds to one decimal place; null stays null (no data is not zero). */
export const oneDecimal = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;
