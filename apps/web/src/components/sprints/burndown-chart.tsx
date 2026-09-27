'use client';

import type { Burndown } from '@forge/types';
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from 'react';

import { CHART, niceTicks, plotHeight, plotWidth, shortDate } from './chart-frame';

/**
 * Remaining story points per day against the ideal line (FR-5.5). One axis, two series:
 * "Remaining" in the first categorical colour and "Ideal" as a recessive grey guide. Hover or
 * arrow keys show every value for a day; the same numbers are in the table below.
 */
export function BurndownChart({ burndown }: { burndown: Burndown }) {
  const { days } = burndown;
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleId = useId();

  const max = Math.max(
    burndown.committed,
    ...days.map((d) => d.remaining ?? 0),
    ...days.map((d) => d.ideal),
    1,
  );
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? max;
  const x = (i: number) =>
    CHART.left + (days.length <= 1 ? plotWidth / 2 : (i * plotWidth) / (days.length - 1));
  const y = (v: number) => CHART.top + plotHeight - (v / top) * plotHeight;

  const known = days
    .map((d, i) => ({ i, remaining: d.remaining }))
    .filter((d): d is { i: number; remaining: number } => d.remaining !== null);
  const remainingPath = known
    .map((d, k) => `${k === 0 ? 'M' : 'L'}${x(d.i)},${y(d.remaining)}`)
    .join('');
  const idealPath = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.ideal)}`).join('');
  const last = known.at(-1);

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const localX = ((event.clientX - box.left) / box.width) * CHART.width;
    const fraction = (localX - CHART.left) / plotWidth;
    setActive(Math.min(days.length - 1, Math.max(0, Math.round(fraction * (days.length - 1)))));
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    setActive((current) => Math.min(days.length - 1, Math.max(0, (current ?? -1) + step)));
  };

  const day = active === null ? null : days[active];
  const summary = last
    ? `${String(last.remaining)} of ${String(burndown.committed)} committed points remaining`
    : `${String(burndown.committed)} points planned; the sprint has not started`;
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));

  return (
    <figure className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <figcaption id={titleId} className="font-medium">
          Burndown <span className="font-normal text-muted-foreground">· {summary}</span>
        </figcaption>
        <ul className="flex gap-4 text-xs text-muted-foreground" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded bg-chart-1" />
            Remaining
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded bg-muted-foreground/60" />
            Ideal
          </li>
        </ul>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${String(CHART.width)} ${String(CHART.height)}`}
          className="w-full overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => {
            setActive(null);
          }}
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
          {days.map((d, i) =>
            i % labelEvery === 0 || i === days.length - 1 ? (
              <text
                key={d.date}
                x={x(i)}
                y={CHART.height - 10}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {shortDate(d.date)}
              </text>
            ) : null,
          )}

          <path
            d={idealPath}
            fill="none"
            strokeWidth={1.5}
            className="stroke-muted-foreground/60"
          />
          {remainingPath && (
            <path
              d={remainingPath}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="stroke-chart-1"
            />
          )}
          {last && (
            <>
              <circle cx={x(last.i)} cy={y(last.remaining)} r={6} className="fill-background" />
              <circle cx={x(last.i)} cy={y(last.remaining)} r={4} className="fill-chart-1" />
            </>
          )}

          {day && active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={CHART.top}
              y2={CHART.top + plotHeight}
              className="stroke-foreground/40"
              strokeWidth={1}
            />
          )}
          <rect
            x={CHART.left}
            y={CHART.top}
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            onPointerMove={pick}
            onPointerLeave={() => {
              setActive(null);
            }}
          />
        </svg>

        {day && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-36 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-md"
            style={{ left: `${String((x(active) / CHART.width) * 100)}%` }}
          >
            <p className="mb-1 text-muted-foreground">{shortDate(day.date)}</p>
            <p className="flex items-center gap-2">
              <span aria-hidden="true" className="h-0.5 w-3 rounded bg-chart-1" />
              <strong className="tabular-nums">{day.remaining ?? '—'}</strong>
              <span className="text-muted-foreground">remaining</span>
            </p>
            <p className="flex items-center gap-2">
              <span aria-hidden="true" className="h-0.5 w-3 rounded bg-muted-foreground/60" />
              <strong className="tabular-nums">{day.ideal}</strong>
              <span className="text-muted-foreground">ideal</span>
            </p>
            {day.scopeChange !== 0 && (
              <p className="mt-1 text-muted-foreground">
                Scope {day.scopeChange > 0 ? '+' : ''}
                {day.scopeChange} pts
              </p>
            )}
          </div>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Show data table
        </summary>
        <table className="mt-2 w-full text-left text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Remaining</th>
              <th className="py-1 font-medium">Ideal</th>
              <th className="py-1 font-medium">Scope change</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-t">
                <td className="py-1">{shortDate(d.date)}</td>
                <td className="py-1">{d.remaining ?? '—'}</td>
                <td className="py-1">{d.ideal}</td>
                <td className="py-1">{d.scopeChange === 0 ? '' : d.scopeChange}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
