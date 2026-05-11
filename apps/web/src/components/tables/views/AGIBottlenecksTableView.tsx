"use client";

// AGI Bottlenecks — supply-chain map of frontier capability inputs (QUA-1124)
import { useCallback } from "react";
import {
  createAGIBottlenecksColumns,
  AGI_BOTTLENECKS_COLUMNS,
  AGI_BOTTLENECKS_PRESETS,
} from "../agi-bottlenecks-columns";
import {
  agiBottlenecks,
  AGI_BOTTLENECK_CATEGORIES,
} from "@data/tables/agi-bottlenecks";
import { TableViewPage } from "../shared/TableViewPage";

const CATEGORY_DOT_COLORS: Record<string, string> = {
  "Compute & Chips": "#7c3aed",
  "Physical Infrastructure": "#ea580c",
  "Data & Algorithms": "#0891b2",
  "Capital & Talent": "#16a34a",
  Governance: "#475569",
};

export default function AGIBottlenecksTableView() {
  const createColumns = useCallback(() => createAGIBottlenecksColumns(), []);

  return (
    <TableViewPage
      data={agiBottlenecks}
      createColumns={createColumns}
      columnConfig={AGI_BOTTLENECKS_COLUMNS}
      columnPresets={AGI_BOTTLENECKS_PRESETS}
      pinnedColumn="name"
      defaultSorting={[{ id: "tightness", desc: true }]}
      grouping={{
        groupByField: "category",
        groupOrder: [...AGI_BOTTLENECK_CATEGORIES],
        groupLabels: Object.fromEntries(
          AGI_BOTTLENECK_CATEGORIES.map((c) => [c, c])
        ),
        headerStyle: "inline-color",
        groupDotColors: CATEGORY_DOT_COLORS,
        hideCategoryColumnInGroupedMode: true,
        categoryColumnId: "category",
      }}
      description={
        <div className="max-w-4xl space-y-3">
          <p className="text-sm text-muted-foreground">
            A supply-chain map of the inputs that gate frontier AI capability. Each row
            is something the next capability generation needs more of; the columns
            assess how constrained that input is today, how fast it can be relieved,
            who controls it, and where it is concentrated.
          </p>
          <p className="text-sm text-muted-foreground">
            Useful as a strategic map: the bottlenecks define where governance
            interventions have leverage. Columns are sorted by tightness — binding
            constraints at the top.
          </p>
          <div className="bg-amber-100 dark:bg-amber-950 border border-amber-300 dark:border-amber-800 rounded-lg p-3 text-[12px] text-amber-900 dark:text-amber-200">
            <strong>Tightness</strong> answers &ldquo;is this a binding constraint right
            now?&rdquo; — <em>BINDING</em> means supply caps capability gains at any
            price; <em>SLACK</em> means it is not currently a bottleneck.{" "}
            <strong>Trajectory</strong> answers &ldquo;is the constraint getting
            worse?&rdquo;
          </div>
        </div>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {agiBottlenecks.length} bottlenecks across {AGI_BOTTLENECK_CATEGORIES.length}{" "}
          categories. Snapshot as of 2026-05; bottleneck dynamics change on
          quarter-to-year timescales.
        </div>
      }
    />
  );
}
