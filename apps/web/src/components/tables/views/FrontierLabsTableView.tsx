"use client";

// Frontier AI Labs Comparison Table view.
// Hand-curated editorial ratings of major AI labs on safety-relevant dimensions.

import { useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  createFrontierLabsColumns,
  FRONTIER_LABS_COLUMNS,
  FRONTIER_LABS_PRESETS,
} from "../frontier-labs-columns";
import {
  frontierLabs,
  FRONTIER_LAB_CATEGORIES,
} from "@data/tables/frontier-labs";
import { TableViewPage } from "../shared/TableViewPage";

export default function FrontierLabsTableView() {
  const createColumns = useCallback(() => createFrontierLabsColumns(), []);

  return (
    <TableViewPage
      data={frontierLabs}
      createColumns={createColumns}
      columnConfig={FRONTIER_LABS_COLUMNS}
      columnPresets={FRONTIER_LABS_PRESETS}
      pinnedColumn="name"
      stickyFirstColumn
      grouping={{
        groupByField: "category",
        groupOrder: FRONTIER_LAB_CATEGORIES.map((c) => c.id),
        groupLabels: Object.fromEntries(
          FRONTIER_LAB_CATEGORIES.map((c) => [c.id, c.label])
        ),
        headerStyle: "colored-dot",
        groupDotClasses: {
          "us-frontier": "bg-blue-500",
          "frontier-china": "bg-red-500",
          "frontier-europe": "bg-indigo-500",
          specialized: "bg-amber-500",
          historical: "bg-slate-500",
        },
        hideCategoryColumnInGroupedMode: true,
        categoryColumnId: "category",
      }}
      description={
        <p className="text-sm text-muted-foreground leading-relaxed max-w-3xl">
          Hand-curated editorial comparison of major frontier AI developers on
          safety-relevant dimensions. Each rating cell shows a level
          (HIGH / MEDIUM / LOW / UNCLEAR) plus a short note anchoring the
          rating in observable signals. Full epistemic caveats and methodology
          are in the page body above. The capability "Tier" column is
          descriptive, not evaluative; all other columns use HIGH = safety-
          positive.
        </p>
      }
      legend={
        <Card className="max-w-fit">
          <CardContent className="py-4">
            <div className="flex flex-wrap gap-6 text-[10px]">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">
                  Safety dimensions (HIGH = safety-positive)
                </p>
                <div className="flex flex-col gap-0.5">
                  <span>
                    <strong>HIGH</strong> — Strong observable signal in the
                    safety-positive direction
                  </span>
                  <span>
                    <strong>MEDIUM</strong> — Mixed evidence or partial commitment
                  </span>
                  <span>
                    <strong>LOW</strong> — Weak / minimal / counter-evidence
                  </span>
                  <span>
                    <strong>UNCLEAR</strong> — Not enough public signal to rate
                  </span>
                  <span>
                    <strong>NONE</strong> — No corresponding practice / policy exists
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">
                  Capability tier (descriptive)
                </p>
                <div className="flex flex-col gap-0.5">
                  <span>
                    <strong>FRONTIER</strong> — At or near absolute frontier
                  </span>
                  <span>
                    <strong>NEAR-FRONTIER</strong> — Competitive in their tier, behind frontier
                  </span>
                  <span>
                    <strong>SPECIALIZED</strong> — Enterprise / niche focus
                  </span>
                  <span>
                    <strong>DEFUNCT</strong> — No longer pursuing frontier
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {frontierLabs.length} labs across{" "}
          {FRONTIER_LAB_CATEGORIES.length} categories. Ratings updated to early
          2026; check references for current state. See linked organization
          pages for FactBase facts (funding, headcount, leadership history).
        </div>
      }
    />
  );
}
