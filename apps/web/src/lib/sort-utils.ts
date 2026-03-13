/** Sort direction shared across all directory tables. */
export type SortDir = "asc" | "desc";

/**
 * Generic comparator: extracts a sort value from each row, handles nulls-last,
 * and compares strings via localeCompare and numbers via subtraction.
 */
export function compareByValue<T>(
  a: T,
  b: T,
  getValue: (row: T) => string | number | null,
  sortDir: SortDir,
): number {
  const dir = sortDir === "asc" ? 1 : -1;
  const va = getValue(a);
  const vb = getValue(b);

  // Nulls sort last regardless of direction
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;

  if (typeof va === "string" && typeof vb === "string") {
    return va.localeCompare(vb) * dir;
  }
  return ((va as number) - (vb as number)) * dir;
}
