'use client';

import type { Velocity } from '@forge/types';
import { useId, useState } from 'react';

import { CHART, niceTicks, plotHeight, plotWidth } from './chart-frame';

const BAR = 20; // ≤ 24px columns, grouped in pairs with a 2px gap
const GAP = 2;

/**
 * Committed vs completed points for recent sprints (FR-5.4), as paired columns on one axis,
 * with the average completed points as a reference line.
 */
export function VelocityChart({ velocity }: { velocity: Velocity }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const rows = velocity.sprints;

  const max = Math.max(1, ...rows.flatMap((r) => [r.committed, r.completed]));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? max;
  const band = plotWidth / Math.max(rows.length, 1);
  const y = (v: number) => CHART.top + plotHeight - (v / top) * plotHeight;
  const baseline = CHART.top + plotHeight;
  const center = (i: number) => CHART.left + band * i + band / 2;

  /** A column with a 4px rounded top, square at the baseline. */
  const column = (xLeft: number, value: number) => {
    const h = Math.max(0, baseline - y(value));
    if (h === 0) return '';
    const r = Math.min(4, h, BAR / 2);
    const yTop = baseline - h;
    return `M${xLeft},${baseline}V${yTop + r}Q${xLeft},${yTop} ${xLeft + r},${yTop}H${xLeft + BAR - r}Q${xLeft + BAR},${yTop} ${xLeft + BAR},${yTop + r}V${baseline}Z`;
  };

  const row = active === null ? null : rows[active];

  return (
    <figure className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <figcaption id={titleId} className="font-medium">
          Velocity{' '}
          <span className="font-normal text-muted-foreground">
            ·{' '}
            {velocity.average === null
              ? 'no completed sprints yet'
              : `${String(velocity.average)} points per sprint on average`}
          </span>
        </figcaption>
        <ul className="flex gap-4 text-xs text-muted-foreground" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-chart-2" />
            Committed
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-chart-1" />
            Completed
          </li>
        </ul>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Complete a sprint to see velocity.
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
                  {tick}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const c = center(i);
              return (
                <g
                  key={r.id}
                  tabIndex={0}
                  role="img"
                  aria-label={`${r.name}: ${String(r.completed)} of ${String(r.committed)} points completed`}
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
                    x={c - band / 2}
                    y={CHART.top}
                    width={band}
                    height={plotHeight}
                    fill="transparent"
                  />
                  <path
                    d={column(c - BAR - GAP / 2, r.committed)}
                    className="fill-chart-2"
                    opacity={active === i || active === null ? 1 : 0.5}
                  />
                  <path
                    d={column(c + GAP / 2, r.completed)}
                    className="fill-chart-1"
                    opacity={active === i || active === null ? 1 : 0.5}
                  />
                  <text
                    x={c + GAP / 2 + BAR / 2}
                    y={y(r.completed) - 6}
                    textAnchor="middle"
                    className="fill-foreground text-[11px] font-medium tabular-nums"
                  >
                    {r.completed}
                  </text>
                  <text
                    x={c}
                    y={CHART.height - 10}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {r.name.length > 14 ? `${r.name.slice(0, 13)}…` : r.name}
                  </text>
                </g>
              );
            })}
            {velocity.average !== null && (
              <g aria-hidden="true">
                <line
                  x1={CHART.left}
                  x2={CHART.width - CHART.right}
                  y1={y(velocity.average)}
                  y2={y(velocity.average)}
                  className="stroke-foreground/50"
                  strokeWidth={1}
                />
                <text
                  x={CHART.width - CHART.right}
                  y={y(velocity.average) - 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[11px]"
                >
                  avg {velocity.average}
                </text>
              </g>
            )}
          </svg>
          {row && active !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-2 z-10 min-w-36 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-md"
              style={{ left: `${String((center(active) / CHART.width) * 100)}%` }}
            >
              <p className="mb-1 text-muted-foreground">{row.name}</p>
              <p className="flex items-center gap-2">
                <span aria-hidden="true" className="h-0.5 w-3 rounded bg-chart-1" />
                <strong className="tabular-nums">{row.completed}</strong>
                <span className="text-muted-foreground">completed</span>
              </p>
              <p className="flex items-center gap-2">
                <span aria-hidden="true" className="h-0.5 w-3 rounded bg-chart-2" />
                <strong className="tabular-nums">{row.committed}</strong>
                <span className="text-muted-foreground">committed</span>
              </p>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show data table
          </summary>
          <table className="mt-2 w-full text-left text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Sprint</th>
                <th className="py-1 font-medium">Committed</th>
                <th className="py-1 font-medium">Completed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1">{r.name}</td>
                  <td className="py-1">{r.committed}</td>
                  <td className="py-1">{r.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
