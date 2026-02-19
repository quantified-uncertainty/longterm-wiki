"use client"

// Table view for AI Evaluation Types - Strategic Analysis
import { useState, useMemo, useCallback } from "react"
import {
  createEvalTypesColumns,
  EVAL_TYPES_COLUMNS,
  EVAL_TYPES_PRESETS,
} from "../eval-types-columns"
import { evalTypes, EVAL_CATEGORIES } from "@data/tables/eval-types"
import { cn } from "@/lib/utils"
import { TableViewPage } from "../shared/TableViewPage"

export default function EvalTypesTableView() {
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)

  const createColumns = useCallback(() => createEvalTypesColumns(), [])

  const filteredData = useMemo(() => {
    if (!categoryFilter) return evalTypes
    return evalTypes.filter((e) => e.category === categoryFilter)
  }, [categoryFilter])

  return (
    <TableViewPage
      navLinks={[
        {
          label: "Eval Types",
          href: "/wiki/eval-types-table/",
          active: true,
        },
        {
          label: "Architectures",
          href: "/wiki/architecture-scenarios-table/",
        },
        {
          label: "Safety Approaches",
          href: "/wiki/safety-approaches-table/",
        },
      ]}
      data={filteredData}
      createColumns={createColumns}
      columnConfig={EVAL_TYPES_COLUMNS}
      columnPresets={EVAL_TYPES_PRESETS}
      pinnedColumn="name"
      grouping={{
        groupByField: "category",
        groupOrder: [...EVAL_CATEGORIES],
        groupLabels: Object.fromEntries(EVAL_CATEGORIES.map((c) => [c, c])),
        headerStyle: "purple-dot",
        hideCategoryColumnInGroupedMode: true,
        categoryColumnId: "category",
      }}
      aboveControls={
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium mr-1">
            Filter by category:
          </span>
          <button
            className={cn(
              "px-2.5 py-1 rounded text-[11px] border transition-colors",
              !categoryFilter
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            )}
            onClick={() => setCategoryFilter(null)}
          >
            All
          </button>
          {EVAL_CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={cn(
                "px-2.5 py-1 rounded text-[11px] border transition-colors",
                categoryFilter === cat
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
              onClick={() => setCategoryFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      }
      description={
        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Comprehensive analysis of AI evaluation approaches and their
            strategic value for different risk scenarios.
            <strong className="text-foreground"> Key insight:</strong> No single
            eval approach is sufficient. Behavioral evals are gameable;
            interpretability isn&apos;t ready; human red teaming doesn&apos;t scale. A
            portfolio approach is required, with emphasis shifting based on
            which risks you prioritize.
          </p>
          <p className="text-xs text-muted-foreground">
            <strong>Risk coverage:</strong> &#x25cf; = strong signal, &#x25d0; = partial
            signal, &#x25cb; = weak signal.
            <strong> Architecture dependence:</strong> LOW means works on any
            model; HIGH means needs specific access/architecture.
          </p>
        </div>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {filteredData.length} evaluation types
          {categoryFilter && ` in ${categoryFilter}`}
          {!categoryFilter && ` across ${EVAL_CATEGORIES.length} categories`}
        </div>
      }
    />
  )
}
