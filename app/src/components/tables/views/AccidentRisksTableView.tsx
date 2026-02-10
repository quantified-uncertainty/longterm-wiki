"use client"

// Accident Risks Comparison Table
import { useState, useMemo, useCallback } from "react"
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  type VisibilityState,
  type ColumnDef,
} from "@tanstack/react-table"
import { DataTable } from "@/components/ui/data-table"
import { TableViewHeader } from "../shared/TableViewHeader"
import { ColumnToggleControls } from "../shared/ColumnToggleControls"
import { ViewModeToggle, type ViewMode } from "../shared/ViewModeToggle"
import {
  createAccidentRisksColumns,
  ACCIDENT_RISKS_COLUMNS,
  ACCIDENT_RISKS_PRESETS,
  type AccidentRisksColumnKey,
} from "../accident-risks-columns"
import { useColumnVisibility } from "../shared/useColumnVisibility"
import { riskCategoryColors, getBadgeClass } from "../shared/table-view-styles"
import {
  accidentRisks,
  riskCategories,
  type AccidentRisk,
} from "@data/tables/accident-risks"
import { cn } from "@/lib/utils"

function LegendBadge({ level, category }: { level: string; category?: string }) {
  const displayLevel = level
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold",
        getBadgeClass(level, category)
      )}
    >
      {displayLevel}
    </span>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-6 mb-6 p-4 bg-muted/30 rounded-lg max-w-6xl">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Abstraction Level
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="THEORETICAL" category="abstraction" /> Foundational
          concepts
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MECHANISM" category="abstraction" /> How failures
          occur
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="BEHAVIOR" category="abstraction" /> Observable
          actions
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="OUTCOME" category="abstraction" /> Resulting
          scenarios
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Evidence</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="OBSERVED_CURRENT" category="evidence" /> In current
          systems
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="DEMONSTRATED_LAB" category="evidence" /> Lab
          experiments
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="THEORETICAL" category="evidence" /> First principles
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="SPECULATIVE" category="evidence" /> Hypothesized
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Timeline</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="CURRENT" category="timeline" /> Now
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="NEAR_TERM" category="timeline" /> 1-3 years
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MEDIUM_TERM" category="timeline" /> 3-10 years
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="LONG_TERM" category="timeline" /> 10+ years
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Severity</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="EXISTENTIAL" category="severity" /> Extinction risk
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="CATASTROPHIC" category="severity" /> Civilizational
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="HIGH" category="severity" /> Significant harm
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MEDIUM" category="severity" /> Real harm
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="LOW" category="severity" /> Minor harm
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Detectability
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="EASY" category="detectability" /> Obvious
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MODERATE" category="detectability" /> With effort
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="DIFFICULT" category="detectability" /> Sophisticated
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="VERY_DIFFICULT" category="detectability" /> May be
          impossible
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Relationships
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="requires" category="relationship" /> Needs as
          precondition
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="enables" category="relationship" /> Can lead to
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="overlaps" category="relationship" /> Conceptual
          similarity
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="manifestation-of" category="relationship" />{" "}
          Behavioral expression
        </div>
      </div>
    </div>
  )
}

function GroupedCategoryTable({
  category,
  color,
  data,
  columns,
  columnVisibility,
}: {
  category: string
  color: string
  data: AccidentRisk[]
  columns: ColumnDef<AccidentRisk>[]
  columnVisibility: VisibilityState
}) {
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  })

  if (data.length === 0) return null

  return (
    <div className="space-y-2 mb-8">
      <div className="flex items-center gap-3 pb-2 border-b-2 border-border">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <div className="text-base font-semibold text-foreground">{category}</div>
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  )
}

export default function AccidentRisksTableView() {
  const [viewMode, setViewMode] = useState<ViewMode>("unified")
  const [sorting, setSorting] = useState<SortingState>([
    { id: "category", desc: false },
  ])

  const { visibleColumns, toggleColumn, applyPreset } = useColumnVisibility({
    columns: ACCIDENT_RISKS_COLUMNS,
    presets: ACCIDENT_RISKS_PRESETS,
  })

  const columnVisibility = useMemo(() => {
    const visibility: VisibilityState = { name: true }
    Object.keys(ACCIDENT_RISKS_COLUMNS).forEach((key) => {
      visibility[key] = visibleColumns.has(key as AccidentRisksColumnKey)
    })
    return visibility
  }, [visibleColumns])

  const scrollToRisk = useCallback((riskId: string) => {
    const element = document.getElementById(`risk-${riskId}`)
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" })
      element.style.background = "#fef3c7"
      setTimeout(() => {
        element.style.background = ""
      }, 2000)
    }
  }, [])

  const columns = useMemo(
    () => createAccidentRisksColumns(scrollToRisk),
    [scrollToRisk]
  )

  const table = useReactTable({
    data: accidentRisks,
    columns,
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const groupedData = useMemo(() => {
    return riskCategories.map((cat) => ({
      category: cat,
      color: riskCategoryColors[cat] || "#6b7280",
      data: accidentRisks.filter((r) => r.category === cat),
    }))
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TableViewHeader
        title="AI Accident Risks: Overlap Analysis"
        breadcrumbs={[
          { label: "Accident Risks", href: "/wiki/accident-risks/" },
          { label: "All Tables", href: "/wiki/interactive-views/" },
        ]}
      />

      <div className="p-4 space-y-4">
        <ColumnToggleControls
          columns={ACCIDENT_RISKS_COLUMNS}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          presets={ACCIDENT_RISKS_PRESETS}
          applyPreset={applyPreset}
        />

        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Comparative analysis of AI accident risks with explicit handling of
            overlaps and relationships. Many risks are closely related - scheming
            is the behavioral expression of deceptive alignment, which requires
            mesa-optimization as a precondition.
          </p>

          <div className="bg-red-100 dark:bg-red-950 border border-red-300 dark:border-red-800 rounded-lg p-3">
            <strong className="text-red-800 dark:text-red-200">
              Key insight:
            </strong>{" "}
            <span className="text-red-700 dark:text-red-300">
              Risks exist at different levels of abstraction.{" "}
              <em>Theoretical frameworks</em> (mesa-optimization, instrumental
              convergence) describe why problems occur. <em>Mechanisms</em>{" "}
              (deceptive alignment, goal misgeneralization) describe how failures
              happen. <em>Behaviors</em> (scheming, power-seeking) are what we
              observe. <em>Outcomes</em> (treacherous turn, sharp left turn) are
              the resulting scenarios.
            </span>
          </div>

          <div className="bg-blue-100 dark:bg-blue-950 border border-blue-300 dark:border-blue-800 rounded-lg p-3">
            <strong className="text-blue-800 dark:text-blue-200">
              Handling overlaps:
            </strong>{" "}
            <span className="text-blue-700 dark:text-blue-300">
              Each risk shows its <em>related risks</em> with relationship types:
              <strong> requires</strong> (needs the other as precondition),
              <strong> enables</strong> (can lead to),
              <strong> overlaps</strong> (conceptual similarity),
              <strong> manifestation-of</strong> (behavioral expression of),
              <strong> special-case-of</strong> (specific instance).
            </span>
          </div>
        </div>

        <ViewModeToggle
          viewMode={viewMode}
          setViewMode={setViewMode}
          unifiedLabel="Unified Table"
          groupedLabel="Grouped by Category"
        />

        <Legend />

        {viewMode === "unified" ? (
          <div className="overflow-x-auto">
            <DataTable table={table} />
          </div>
        ) : (
          <div>
            {groupedData.map(({ category, color, data }) => (
              <GroupedCategoryTable
                key={category}
                category={category}
                color={color}
                data={data}
                columns={columns}
                columnVisibility={columnVisibility}
              />
            ))}
          </div>
        )}

        <div className="text-xs text-muted-foreground mt-4">
          {accidentRisks.length} risks across {riskCategories.length} categories
        </div>
      </div>
    </div>
  )
}
