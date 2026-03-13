import { compareByValue } from "@/lib/sort-utils";
export type { SortDir } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";

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
  return compareByValue(a, b, (row) => getPersonSortValue(row, sortKey), sortDir);
}
