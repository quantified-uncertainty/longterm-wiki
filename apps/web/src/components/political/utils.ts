/** Convert a numeric value (number or string from PG) to number, returning 0 for null/invalid. */
export function toNum(value: number | string | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}
