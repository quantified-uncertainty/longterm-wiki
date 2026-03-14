import { compareByValue } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";
export type { SortDir };
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
      return (row.recipientName ?? row.recipient)?.toLowerCase() ?? null;
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
  return compareByValue(a, b, (row) => getGrantSortValue(row, sortKey), sortDir);
}
