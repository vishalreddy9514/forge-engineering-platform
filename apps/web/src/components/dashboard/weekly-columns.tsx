'use client';

import { useId, useState } from 'react';

import { CHART, niceTicks, plotHeight, plotWidth, shortDate } from '../sprints/chart-frame';

export interface WeeklySeries {
  label: string;
  /** Tailwind fill/background suffix of a validated chart slot: `chart-1` or `chart-2`. */
  slot: 'chart-1' | 'chart-2';
  values: number[];
}

const GAP = 2; // surface gap between adjacent columns
/** Literal class names, so Tailwind generates them. */
const SLOT = {
  'chart-1': { fill: 'fill-chart-1', bg: 'bg-chart-1' },
  'chart-2': { fill: 'fill-chart-2', bg: 'bg-chart-2' },
} as const;

/**
 * One or two series of weekly values as columns on a single axis (FR-10). Hovering or focusing a
 * week shows its values; the data table below gives the same numbers without the chart.
 */
export function WeeklyColumns({
  title,
  summary,
  weeks,
  series,
  format = String,
  empty,
}: {
  title: string;
  /** Muted text after the title: the headline the chart supports. */
  summary?: string;
  /** Week starts (YYYY-MM-DD), oldest first. */
  weeks: string[];
  series: WeeklySeries[];
  format?: (value: number) => string;
  /** Shown instead of the plot when every value is zero. */
  empty: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  // Every series here counts things, so only whole-number ticks make sense.
  const ticks = niceTicks(max).filter((t) => Number.isInteger(t));
  const top = ticks.at(-1) ?? max;
  const band = plotWidth / Math.max(weeks.length, 1);
  const bar = Math.min(24, (band * 0.7 - GAP * (series.length - 1)) / series.length);
  const baseline = CHART.top + plotHeight;
  const y = (v: number) => baseline - (v / top) * plotHeight;
  const center = (i: number) => CHART.left + band * i + band / 2;
  const left = (i: number, s: number) =>
    center(i) - (series.length * bar + (series.length - 1) * GAP) / 2 + s * (bar + GAP);

  /** A column with a 4px rounded top, square at the baseline. */
  const column = (x: number, value: number) => {
    const h = Math.max(0, baseline - y(value));
    if (h === 0) return '';
    const r = Math.min(4, h, bar / 2);
    const yTop = baseline - h;
    return `M${String(x)},${String(baseline)}V${String(yTop + r)}Q${String(x)},${String(yTop)} ${String(x + r)},${String(yTop)}H${String(x + bar - r)}Q${String(x + bar)},${String(yTop)} ${String(x + bar)},${String(yTop + r)}V${String(baseline)}Z`;
  };

  const isEmpty = series.every((s) => s.values.every((v) => v === 0));
  // Label every week when there is room, otherwise every other one (always the latest).
  const labelEvery = weeks.length > 10 ? 2 : 1;
  const describe = (i: number) =>
    `Week of ${shortDate(weeks[i] ?? '')}: ${series
      .map((s) => `${format(s.values[i] ?? 0)} ${s.label.toLowerCase()}`)
      .join(', ')}`;

  return (
    <figure className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <figcaption id={titleId} className="font-medium">
          {title}
          {summary && <span className="font-normal text-muted-foreground"> · {summary}</span>}
        </figcaption>
        {series.length > 1 && (
          <ul className="flex gap-4 text-xs text-muted-foreground" aria-label="Legend">
            {series.map((s) => (
              <li key={s.label} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`size-2.5 rounded-sm ${SLOT[s.slot].bg}`} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isEmpty ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${String(CHART.width)} ${String(CHART.height)}`}
            className="w-full overflow-visible"
            role="img"
            aria-labelledby={titleId}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={CHART.left}
                  x2={CHART.width - CHART.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={CHART.left - 8}
                  y={y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {format(tick)}
                </text>
              </g>
            ))}
            {weeks.map((week, i) => (
              <g
                key={week}
                tabIndex={0}
                role="img"
                aria-label={describe(i)}
                className="outline-none"
                onPointerEnter={() => {
                  setActive(i);
                }}
                onPointerLeave={() => {
                  setActive(null);
                }}
                onFocus={() => {
                  setActive(i);
                }}
                onBlur={() => {
                  setActive(null);
                }}
              >
                {/* Hit target: the whole band, not just the painted columns. */}
                <rect
                  x={center(i) - band / 2}
                  y={CHART.top}
                  width={band}
                  height={plotHeight}
                  fill="transparent"
                />
                {series.map((s, si) => (
                  <path
                    key={s.label}
                    d={column(left(i, si), s.values[i] ?? 0)}
                    className={SLOT[s.slot].fill}
                    opacity={active === null || active === i ? 1 : 0.5}
                  />
                ))}
                {(i % labelEvery === (weeks.length - 1) % labelEvery || active === i) && (
                  <text
                    x={center(i)}
                    y={CHART.height - 10}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {shortDate(week)}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {active !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-2 z-10 min-w-36 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-md"
              style={{ left: `${String((center(active) / CHART.width) * 100)}%` }}
            >
              <p className="mb-1 text-muted-foreground">Week of {shortDate(weeks[active] ?? '')}</p>
              {series.map((s) => (
                <p key={s.label} className="flex items-center gap-2">
                  <span aria-hidden="true" className={`h-0.5 w-3 rounded ${SLOT[s.slot].bg}`} />
                  <strong className="tabular-nums">{format(s.values[active] ?? 0)}</strong>
                  <span className="text-muted-foreground">{s.label.toLowerCase()}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {!isEmpty && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show data table
          </summary>
          <table className="mt-2 w-full text-left text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Week of</th>
                {series.map((s) => (
                  <th key={s.label} className="py-1 font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week, i) => (
                <tr key={week} className="border-t">
                  <td className="py-1">{shortDate(week)}</td>
                  {series.map((s) => (
                    <td key={s.label} className="py-1">
                      {format(s.values[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
