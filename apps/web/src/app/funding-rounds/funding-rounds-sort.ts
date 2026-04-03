import { compareByValue } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";
export type { SortDir };
import type { FundingRoundRow } from "./funding-rounds-table";

export type FundingRoundSortKey =
  | "name"
  | "company"
  | "raised"
  | "valuation"
  | "instrument"
  | "leadInvestor"
  | "date";

export function getFundingRoundSortValue(
  row: FundingRoundRow,
  sortKey: FundingRoundSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "company":
      return row.companyName.toLowerCase();
    case "raised":
      return row.raised;
    case "valuation":
      return row.valuation;
    case "instrument":
      return row.instrument?.toLowerCase() ?? null;
    case "leadInvestor":
      return row.leadInvestorName?.toLowerCase() ?? null;
    case "date":
      return row.date;
  }
}

export function compareFundingRoundRows(
  a: FundingRoundRow,
  b: FundingRoundRow,
  sortKey: FundingRoundSortKey,
  sortDir: SortDir,
): number {
  return compareByValue(a, b, (row) => getFundingRoundSortValue(row, sortKey), sortDir);
}
