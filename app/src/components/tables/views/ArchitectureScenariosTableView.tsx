"use client"

// Architecture Scenarios Table View
import { useState, useMemo } from "react"
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
  createArchitectureScenariosColumns,
  ARCHITECTURE_COLUMNS,
  ARCHITECTURE_PRESETS,
  type ArchitectureColumnKey,
  type Scenario,
  type Category,
} from "../architecture-scenarios-columns"
import {
  scenarios,
  CATEGORIES,
  CATEGORY_ORDER,
} from "@data/tables/architecture-scenarios"
import { useColumnVisibility } from "../shared/useColumnVisibility"
import { categoryColors } from "../shared/table-view-styles"
import { cn } from "@/lib/utils"

function GroupedCategoryTable({
  category,
  data,
  columns,
  columnVisibility,
}: {
  category: Category
  data: Scenario[]
  columns: ColumnDef<Scenario>[]
  columnVisibility: VisibilityState
}) {
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  })

  if (data.length === 0) return null

  const colors = categoryColors[category]

  return (
    <div className="space-y-2 mb-8">
      <div className="flex items-center gap-3 pb-2 border-b-2 border-border">
        <div className={cn("w-3 h-3 rounded-full shrink-0", colors?.dot)} />
        <div className="text-base font-semibold text-foreground">
          {CATEGORIES[category].label}
        </div>
        <div className="text-sm text-muted-foreground">
          — {CATEGORIES[category].description}
        </div>
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  )
}

export default function ArchitectureScenariosTableView() {
  const [viewMode, setViewMode] = useState<ViewMode>("unified")
  const [sorting, setSorting] = useState<SortingState>([
    { id: "category", desc: false },
  ])

  const { visibleColumns, toggleColumn, applyPreset } = useColumnVisibility({
    columns: ARCHITECTURE_COLUMNS,
    presets: ARCHITECTURE_PRESETS,
  })

  const columnVisibility = useMemo(() => {
    const visibility: VisibilityState = { name: true }
    Object.keys(ARCHITECTURE_COLUMNS).forEach((key) => {
      visibility[key] = visibleColumns.has(key as ArchitectureColumnKey)
    })
    if (viewMode === "unified") {
      visibility.category = true
    }
    return visibility
  }, [visibleColumns, viewMode])

  const columns = useMemo(() => createArchitectureScenariosColumns(), [])

  const table = useReactTable({
    data: scenarios,
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
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      data: scenarios.filter((s) => s.category === cat),
    }))
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TableViewHeader
        title="Scalable Intelligence Paradigms"
        breadcrumbs={[
          { label: "Knowledge Base", href: "/wiki/knowledge-base/" },
          { label: "All Tables", href: "/wiki/interactive-views/" },
        ]}
        navLinks={[
          {
            label: "Model Architectures",
            href: "/wiki/architecture-scenarios-table/",
            active: true,
          },
          {
            label: "Deployment Architectures",
            href: "/wiki/deployment-architectures-table/",
          },
          {
            label: "Safety Approaches",
            href: "/wiki/safety-approaches-table/",
          },
        ]}
      />

      <div className="p-4 space-y-4">
        <ColumnToggleControls
          columns={ARCHITECTURE_COLUMNS}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          presets={ARCHITECTURE_PRESETS}
          applyPreset={applyPreset}
        />

        <div className="max-w-4xl space-y-4">
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground select-none">
              Similar tables elsewhere
            </summary>
            <div className="mt-2 pl-4 border-l-2 border-muted space-y-1">
              <div>
                <a
                  href="https://artificialanalysis.ai/leaderboards/models"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Artificial Analysis
                </a>{" "}
                – Model capabilities (100+ models)
              </div>
              <div>
                <a
                  href="https://epoch.ai/benchmarks"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Epoch AI Benchmarks
                </a>{" "}
                – Historical benchmark trends
              </div>
              <div>
                <a
                  href="https://www.vellum.ai/llm-leaderboard"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Vellum LLM Leaderboard
                </a>{" "}
                – Price &amp; context comparison
              </div>
            </div>
          </details>

          <p className="text-sm text-muted-foreground">
            Paradigms for transformative intelligence.{" "}
            <strong>Structure:</strong> We separate <em>deployment patterns</em>{" "}
            (minimal → heavy scaffolding) from <em>base architectures</em>{" "}
            (transformers, SSMs, etc.). These are orthogonal - real systems
            combine both. E.g., &quot;Heavy scaffolding + MoE transformer&quot; is one
            concrete system.
          </p>

          <p className="text-xs text-muted-foreground">
            <strong>Key insight:</strong> Scaffold code is actually{" "}
            <em>more</em> interpretable than model internals. We can read and
            verify orchestration logic; we can&apos;t read transformer weights.
          </p>
        </div>

        <ViewModeToggle
          viewMode={viewMode}
          setViewMode={setViewMode}
          unifiedLabel="Unified Table"
          groupedLabel="Grouped by Category"
        />

        {viewMode === "unified" ? (
          <div className="overflow-x-auto">
            <DataTable table={table} />
          </div>
        ) : (
          <div>
            {groupedData.map(({ category, data }) => (
              <GroupedCategoryTable
                key={category}
                category={category}
                data={data}
                columns={columns}
                columnVisibility={columnVisibility}
              />
            ))}
          </div>
        )}

        <div className="text-xs text-muted-foreground mt-4">
          {scenarios.length} scenarios across {CATEGORY_ORDER.length} categories
        </div>
      </div>
    </div>
  )
}
