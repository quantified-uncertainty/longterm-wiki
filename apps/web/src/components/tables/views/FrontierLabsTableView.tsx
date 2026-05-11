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
        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Hand-curated editorial comparison of major frontier AI developers on
            safety-relevant dimensions. Each rating cell shows a level
            (HIGH / MEDIUM / LOW / UNCLEAR) plus a short note anchoring the
            rating in observable signals — published policies, system cards,
            leadership statements, and public departures. The full evidence
            list per lab is in the "Notable signals" column.
          </p>
          <Card className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
            <CardContent className="py-3 space-y-2">
              <p className="text-sm">
                <strong className="text-amber-700 dark:text-amber-400">
                  Epistemic status:
                </strong>{" "}
                Opinionated synthesis, not a peer-reviewed scorecard. Ratings
                reflect public observable signals through early 2026; internal
                practices not in the public record are not assessed. "UNCLEAR"
                means we don't have enough public signal — not that the
                underlying practice is bad.
              </p>
              <p className="text-sm">
                <strong className="text-amber-700 dark:text-amber-400">
                  Direction of ratings:
                </strong>{" "}
                For every safety dimension, HIGH means more safety-positive
                (more investment, more restraint, more transparency, stronger
                alignment, more detail). The capability "Tier" column is
                descriptive, not evaluative.
              </p>
              <p className="text-sm">
                <strong className="text-amber-700 dark:text-amber-400">
                  Limits:
                </strong>{" "}
                Ratings age fast — frontier labs reorganize, ship new policies,
                and lose senior staff on quarterly timescales. Update cadence
                here is ~14 days; check linked references for current state.
                We weigh observable artifacts (published RSPs, system cards,
                attrition patterns) more heavily than press statements. Other
                scorecards weight differently — see the cross-references below.
              </p>
            </CardContent>
          </Card>
          <details>
            <summary className="text-sm text-muted-foreground cursor-pointer hover:text-foreground select-none">
              Other lab-comparison scorecards ↗
            </summary>
            <div className="mt-2 pl-4 border-l-2 border-border text-sm space-y-1">
              <div>
                <a
                  href="https://futureoflife.org/ai-safety-index-winter-2025/"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  FLI AI Safety Index
                </a>{" "}
                — Periodic lab scorecards graded by independent reviewers.
              </div>
              <div>
                <a
                  href="https://metr.org/common-elements"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  METR: Common Elements
                </a>{" "}
                — Frontier safety policy comparison across companies.
              </div>
              <div>
                <a
                  href="https://ailabwatch.org/"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  AI Lab Watch
                </a>{" "}
                — Independent third-party scorecard with detailed rubric.
              </div>
              <div>
                <a
                  href="/organizations"
                  className="text-primary hover:underline"
                >
                  /organizations
                </a>{" "}
                — Full organization directory on this wiki, including FactBase
                facts (funding, headcount, valuations).
              </div>
            </div>
          </details>
        </div>
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
