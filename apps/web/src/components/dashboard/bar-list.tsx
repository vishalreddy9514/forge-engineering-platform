export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Shown under the label, in muted text (e.g. "3 issues"). */
  detail?: string;
}

/**
 * Horizontal bars for comparing a few magnitudes (FR-10): one hue, labelled rows, the value
 * printed beside each bar, so the list reads as a table and the bars only add the shape.
 */
export function BarList({
  title,
  rows,
  format = String,
  empty,
}: {
  title: string;
  rows: BarRow[];
  format?: (value: number) => string;
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const hasData = rows.some((r) => r.value > 0);

  return (
    <section aria-label={title} className="grid gap-2 text-sm">
      <h3 className="font-medium">{title}</h3>
      {!hasData ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {rows.map((row) => (
            <li
              key={row.key}
              className="grid grid-cols-[minmax(5rem,9rem)_minmax(2rem,1fr)_auto] items-center gap-3"
            >
              <span className="min-w-0">
                <span className="block truncate">{row.label}</span>
                {row.detail && (
                  <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                )}
              </span>
              <span aria-hidden="true" className="h-2.5">
                {row.value > 0 && (
                  <span
                    className="block h-full rounded-r-[4px] bg-chart-1"
                    style={{ width: `${String(Math.max(2, (row.value / max) * 100))}%` }}
                  />
                )}
              </span>
              <span className="text-right whitespace-nowrap tabular-nums">{format(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
