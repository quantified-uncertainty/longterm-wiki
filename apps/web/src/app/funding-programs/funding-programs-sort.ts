import { compareByValue } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";
export type { SortDir };
import type { FundingProgramListRow } from "./funding-programs-table";

export type FPSortKey =
  | "name"
  | "organization"
  | "type"
  | "budget"
  | "status"
  | "deadline";

export function getFPSortValue(
  row: FundingProgramListRow,
  sortKey: FPSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "organization":
      return row.orgName.toLowerCase();
    case "type":
      return row.programType;
    case "budget":
      return row.totalBudget;
    case "status":
      return row.status;
    case "deadline":
      return row.deadline;
  }
}

export function compareFPRows(
  a: FundingProgramListRow,
  b: FundingProgramListRow,
  sortKey: FPSortKey,
  sortDir: SortDir,
): number {
  return compareByValue(a, b, (row) => getFPSortValue(row, sortKey), sortDir);
}
