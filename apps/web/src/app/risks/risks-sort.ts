import { compareByValue } from "@/lib/sort-utils";
export type { SortDir } from "@/lib/sort-utils";
import type { SortDir } from "@/lib/sort-utils";

import type { RiskRow } from "./risks-table";
import { SEVERITY_ORDER, LIKELIHOOD_ORDER } from "./risk-constants";

export type RiskSortKey = "name" | "category" | "severity" | "likelihood" | "timeHorizon";

export function getRiskSortValue(
  row: RiskRow,
  sortKey: RiskSortKey,
): string | number | null {
  switch (sortKey) {
    case "name":
      return row.name.toLowerCase();
    case "category":
      return row.riskCategory ?? "";
    case "severity":
      return row.severity ? (SEVERITY_ORDER[row.severity] ?? 0) : null;
    case "likelihood":
      return row.likelihood ? (LIKELIHOOD_ORDER[row.likelihood] ?? 0) : null;
    case "timeHorizon":
      return row.timeHorizon ?? null;
  }
}

export function compareRiskRows(
  a: RiskRow,
  b: RiskRow,
  sortKey: RiskSortKey,
  sortDir: SortDir,
): number {
  return compareByValue(a, b, (row) => getRiskSortValue(row, sortKey), sortDir);
}
