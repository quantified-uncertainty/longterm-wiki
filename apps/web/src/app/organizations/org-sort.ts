import type { OrgRow } from "./organizations-table";

export type OrgSortKey =
  | "name"
  | "orgType"
  | "revenue"
  | "valuation"
  | "headcount"
  | "totalFunding"
  | "founded";

export type SortDir = "asc" | "desc";

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
  const dir = sortDir === "asc" ? 1 : -1;
  const va = getOrgSortValue(a, sortKey);
  const vb = getOrgSortValue(b, sortKey);

  // Nulls sort last regardless of direction
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;

  if (typeof va === "string" && typeof vb === "string") {
    return va.localeCompare(vb) * dir;
  }
  return ((va as number) - (vb as number)) * dir;
}
