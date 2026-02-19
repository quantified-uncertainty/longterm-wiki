// TransitionModelTable - Server Component wrapper
// Extracts sub-item data from parameter graph nodes on the server,
// then passes serializable props to the client component for interactive rendering.

import { getRootFactors, getScenarios, getOutcomes } from "@/data/parameter-graph-data";
import type { RootFactor } from "@/data/parameter-graph-data";
import TransitionModelTableClient from "./TransitionModelTableClient";
import type { SubItemRow } from "./TransitionModelTableClient";

export type { SubItemRow };

function extractSubItems(
  nodes: RootFactor[],
  _type: "cause" | "intermediate" | "effect"
): SubItemRow[] {
  const rows: SubItemRow[] = [];
  const sorted = [...nodes].sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999)
  );
  for (const node of sorted) {
    if (node.subItems && node.subItems.length > 0) {
      for (const subItem of node.subItems) {
        rows.push({
          subItem: subItem.label,
          description: subItem.description || "",
          href: subItem.href,
          parent: node.label,
          parentId: node.id,
          subgroup: node.subgroup,
          ratings: subItem.ratings as SubItemRow["ratings"],
        });
      }
    }
  }
  return rows;
}

export default function TransitionModelTable() {
  const causeRows = extractSubItems(getRootFactors(), "cause");
  const intermediateRows = extractSubItems(getScenarios(), "intermediate");
  const effectRows = extractSubItems(getOutcomes(), "effect");

  return (
    <TransitionModelTableClient
      causeRows={causeRows}
      intermediateRows={intermediateRows}
      effectRows={effectRows}
    />
  );
}

// Named export alias for backward compatibility in MDX
export const TransitionModelInteractive = TransitionModelTable;
