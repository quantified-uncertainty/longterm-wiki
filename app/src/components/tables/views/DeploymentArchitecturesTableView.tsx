"use client"

// Table view for Deployment / Safety Architectures
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
  createDeploymentArchitecturesColumns,
  DEPLOYMENT_COLUMNS,
  DEPLOYMENT_PRESETS,
  CATEGORIES,
  type DeploymentColumnKey,
  type Architecture,
  type Category,
} from "../deployment-architectures-columns"
import { useColumnVisibility } from "../shared/useColumnVisibility"
import { architectures, CATEGORY_ORDER } from "@data/tables/ai-architectures"

function GroupedCategoryTable({
  category,
  data,
  columns,
  columnVisibility,
}: {
  category: Category
  data: Architecture[]
  columns: ColumnDef<Architecture>[]
  columnVisibility: VisibilityState
}) {
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="space-y-2">
      <div className="bg-slate-900 text-white px-4 py-2 rounded-t-md font-semibold text-sm uppercase tracking-wide">
        {CATEGORIES[category].label} — {CATEGORIES[category].description}
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  )
}

export default function DeploymentArchitecturesTableView() {
  const [viewMode, setViewMode] = useState<ViewMode>("grouped")
  const [sorting, setSorting] = useState<SortingState>([])

  const { visibleColumns, toggleColumn, applyPreset } =
    useColumnVisibility({
      columns: DEPLOYMENT_COLUMNS,
      presets: DEPLOYMENT_PRESETS,
    })

  const columnVisibility = useMemo(() => {
    const visibility: VisibilityState = { name: true }
    Object.keys(DEPLOYMENT_COLUMNS).forEach((key) => {
      visibility[key] = visibleColumns.has(key as DeploymentColumnKey)
    })
    return visibility
  }, [visibleColumns])

  const columns = useMemo(() => createDeploymentArchitecturesColumns(), [])

  const table = useReactTable({
    data: architectures,
    columns,
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const archByCategory = useMemo(() => {
    return architectures.reduce(
      (acc, a) => {
        if (!acc[a.category]) acc[a.category] = []
        acc[a.category].push(a)
        return acc
      },
      {} as Record<Category, Architecture[]>
    )
  }, [])

  const groupedData = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      data: archByCategory[category] || [],
    }))
  }, [archByCategory])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TableViewHeader
        title="Deployment / Safety Architectures"
        breadcrumbs={[
          {
            label: "Knowledge Base",
            href: "/wiki/knowledge-base/",
          },
          { label: "All Tables", href: "/wiki/interactive-views/" },
        ]}
        navLinks={[
          {
            label: "Model Architectures",
            href: "/wiki/architecture-scenarios-table/",
          },
          {
            label: "Deployment Architectures",
            href: "/wiki/deployment-architectures-table/",
            active: true,
          },
          {
            label: "Safety Approaches",
            href: "/wiki/safety-approaches-table/",
          },
        ]}
      />

      <div className="p-4 space-y-4">
        <ColumnToggleControls
          columns={DEPLOYMENT_COLUMNS}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          presets={DEPLOYMENT_PRESETS}
          applyPreset={applyPreset}
        />

        <div className="max-w-4xl space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">
              How AI systems are organized for safety.
            </strong>{" "}
            These architectures are largely model-agnostic - they can be applied
            to transformers, SSMs, or future architectures. The key question:
            how do we structure AI systems to maintain oversight and safety?
          </p>
          <p className="text-xs">
            <strong>Key insight:</strong> Lower agency + more decomposition +
            better oversight = generally safer. But there are tradeoffs with
            capability and practicality. See also:{" "}
            <a
              href="/wiki/architecture-scenarios-table/"
              className="text-primary hover:underline"
            >
              Model Architectures
            </a>{" "}
            for what the AI is made of.
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
          <div className="space-y-6">
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
          {architectures.length} architectures across {CATEGORY_ORDER.length}{" "}
          categories
        </div>
      </div>
    </div>
  )
}
