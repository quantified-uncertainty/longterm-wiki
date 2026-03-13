import { compareByValue } from "@/lib/sort-utils";
export type { SortDir } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";
import type { OrgRow } from "./organizations-table";

export type OrgSortKey =
  | "name"
  | "orgType"
  | "revenue"
  | "valuation"
  | "headcount"
  | "totalFunding"
  | "founded";

export function getOrgSortValue(
  row: OrgRow,
  sortKey: OrgSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "orgType":
      return row.orgType ?? "";
    case "revenue":
      return row.revenueNum;
    case "valuation":
      return row.valuationNum;
    case "headcount":
      return row.headcount;
    case "totalFunding":
      return row.totalFundingNum;
    case "founded":
      return row.foundedDate;
  }
}

export function compareOrgRows(
  a: OrgRow,
  b: OrgRow,
  sortKey: OrgSortKey,
  sortDir: SortDir,
): number {
  return compareByValue(a, b, (row) => getOrgSortValue(row, sortKey), sortDir);
}
