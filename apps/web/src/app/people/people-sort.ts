import type { PersonRow } from "./people-table";

export type PeopleSortKey =
  | "name"
  | "role"
  | "employer"
  | "bornYear"
  | "netWorth"
  | "positions"
  | "publications"
  | "careerHistory";

export type SortDir = "asc" | "desc";

export function getPersonSortValue(
  row: PersonRow,
  sortKey: PeopleSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "role":
      return row.role?.toLowerCase() ?? null;
    case "employer":
      return row.employerName?.toLowerCase() ?? null;
    case "bornYear":
      return row.bornYear;
    case "netWorth":
      return row.netWorthNum;
    case "positions":
      return row.positionCount || null;
    case "publications":
      return row.publicationCount || null;
    case "careerHistory":
      return row.careerHistoryCount;
  }
}

export function comparePersonRows(
  a: PersonRow,
  b: PersonRow,
  sortKey: PeopleSortKey,
  sortDir: SortDir,
): number {
  const dir = sortDir === "asc" ? 1 : -1;
  const va = getPersonSortValue(a, sortKey);
  const vb = getPersonSortValue(b, sortKey);

  // Nulls sort last regardless of direction
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;

  if (typeof va === "string" && typeof vb === "string") {
    return va.localeCompare(vb) * dir;
  }
  return ((va as number) - (vb as number)) * dir;
}
