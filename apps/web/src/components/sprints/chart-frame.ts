/** Shared geometry for the small SVG charts: a plot area inside fixed margins. */
export const CHART = { width: 640, height: 240, top: 16, right: 16, bottom: 32, left: 40 };

export const plotWidth = CHART.width - CHART.left - CHART.right;
export const plotHeight = CHART.height - CHART.top - CHART.bottom;

/** Round tick values: 0 up to a "nice" maximum in 4-5 steps. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
}

/** "2026-10-05" → "5 Oct" (UTC, matching how the API buckets days). */
export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
