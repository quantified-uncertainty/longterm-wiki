import type { GrantRow } from "./grants-table";

export type GrantSortKey =
  | "name"
  | "organization"
  | "recipient"
  | "program"
  | "amount"
  | "period"
  | "date"
  | "status";

export type SortDir = "asc" | "desc";

export function getGrantSortValue(
  row: GrantRow,
  sortKey: GrantSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "organization":
      return row.organizationName.toLowerCase();
    case "recipient":
      return row.recipient?.toLowerCase() ?? null;
    case "program":
      return row.program?.toLowerCase() ?? null;
    case "amount":
      return row.amount;
    case "period":
      return row.period;
    case "date":
      return row.date;
    case "status":
      return row.status;
  }
}

export function compareGrantRows(
  a: GrantRow,
  b: GrantRow,
  sortKey: GrantSortKey,
  sortDir: SortDir,
): number {
  const dir = sortDir === "asc" ? 1 : -1;
  const va = getGrantSortValue(a, sortKey);
  const vb = getGrantSortValue(b, sortKey);

  // Nulls sort last regardless of direction
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;

  if (typeof va === "string" && typeof vb === "string") {
    return va.localeCompare(vb) * dir;
  }
  return ((va as number) - (vb as number)) * dir;
}
