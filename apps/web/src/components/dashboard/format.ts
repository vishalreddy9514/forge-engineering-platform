/** 5.5 → "5.5 h", 30 → "30 h", 50 → "2.1 d": hours for short waits, days past two of them. */
export function duration(hours: number | null): string {
  if (hours === null) return '–';
  if (hours < 48) return `${String(Math.round(hours * 10) / 10)} h`;
  return `${String(Math.round((hours / 24) * 10) / 10)} d`;
}

/** Small amounts keep enough digits to be non-zero: $0.0125, $1.24, $12. */
export function usd(value: number): string {
  if (value === 0) return '$0';
  const digits = value < 0.01 ? 4 : value < 10 ? 2 : 0;
  return `$${value.toFixed(digits)}`;
}

/** 950 → "950", 12_400 → "12.4k", 3_100_000 → "3.1M". */
export function compact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}
