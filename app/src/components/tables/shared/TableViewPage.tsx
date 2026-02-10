"use client"

import { useState, useMemo, type ReactNode } from "react"
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  type VisibilityState,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table"
import { cn } from "@/lib/utils"
import { DataTable } from "@/components/ui/data-table"
import { ColumnToggleControls } from "./ColumnToggleControls"
import { ViewModeToggle, type ViewMode } from "./ViewModeToggle"
import { useColumnVisibility, type ColumnConfig } from "./useColumnVisibility"
import {
  GroupedCategorySection,
  type GroupHeaderStyle,
} from "./GroupedCategorySection"

interface NavLink {
  label: string
  href: string
  active?: boolean
}

interface GroupingConfig<TData> {
  groupByField: keyof TData & string
  groupOrder: string[]
  groupLabels: Record<string, string>
  groupDescriptions?: Record<string, string>
  headerStyle: GroupHeaderStyle
  groupDotClasses?: Record<string, string>
  groupDotColors?: Record<string, string>
  hideCategoryColumnInGroupedMode?: boolean
  categoryColumnId?: string
}

export interface TableViewConfig<TData, TColumnKey extends string> {
  // Data + columns
  data: TData[]
  createColumns: () => ColumnDef<TData>[]
  columnConfig: Record<TColumnKey, ColumnConfig>
  columnPresets: Record<string, TColumnKey[]>
  pinnedColumn?: string

  // Navigation between related tables
  navLinks?: NavLink[]

  // Grouping (optional)
  grouping?: GroupingConfig<TData>

  // Defaults
  defaultViewMode?: ViewMode
  defaultSorting?: SortingState

  // Content slots
  description?: ReactNode
  legend?: ReactNode
  aboveControls?: ReactNode
  footer?: ReactNode

  // Table options
  stickyFirstColumn?: boolean
  getRowClassName?: (row: Row<TData>) => string
  className?: string
}

export function TableViewPage<TData, TColumnKey extends string>({
  data,
  createColumns,
  columnConfig,
  columnPresets,
  pinnedColumn,
  navLinks,
  grouping,
  defaultViewMode = "unified",
  defaultSorting = [],
  description,
  legend,
  aboveControls,
  footer,
  stickyFirstColumn,
  getRowClassName,
  className,
}: TableViewConfig<TData, TColumnKey>) {
  const [viewMode, setViewMode] = useState<ViewMode>(defaultViewMode)
  const [sorting, setSorting] = useState<SortingState>(defaultSorting)

  const { visibleColumns, toggleColumn, applyPreset } = useColumnVisibility({
    columns: columnConfig,
    presets: columnPresets,
  })

  const columnVisibility = useMemo(() => {
    const visibility: VisibilityState = {}
    Object.keys(columnConfig).forEach((key) => {
      visibility[key] = visibleColumns.has(key as TColumnKey)
    })
    if (pinnedColumn) {
      visibility[pinnedColumn] = true
    }
    if (
      viewMode === "grouped" &&
      grouping?.hideCategoryColumnInGroupedMode &&
      grouping.categoryColumnId
    ) {
      visibility[grouping.categoryColumnId] = false
    }
    return visibility
  }, [visibleColumns, viewMode, columnConfig, pinnedColumn, grouping])

  const columns = useMemo(() => createColumns(), [createColumns])

  const table = useReactTable({
    data,
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
    if (!grouping) return []
    return grouping.groupOrder
      .map((key) => ({
        key,
        label: grouping.groupLabels[key] || key,
        description: grouping.groupDescriptions?.[key],
        data: data.filter(
          (item) => String(item[grouping.groupByField]) === key
        ),
        dotClass: grouping.groupDotClasses?.[key],
        dotColor: grouping.groupDotColors?.[key],
      }))
      .filter((g) => g.data.length > 0)
  }, [data, grouping])

  return (
    <div className={className ?? "flex flex-col"}>
      {/* Nav links for switching between related tables */}
      {navLinks && navLinks.length > 0 && (
        <nav className="flex items-center gap-1.5 mb-2">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                link.active
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>
      )}

      <div className="space-y-2">
        {aboveControls}

        <ColumnToggleControls
          columns={columnConfig}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          presets={columnPresets}
          applyPreset={applyPreset}
        />

        {/* Collapsible info row */}
        <div className="flex flex-wrap items-center gap-3">
          {grouping && (
            <ViewModeToggle
              viewMode={viewMode}
              setViewMode={setViewMode}
              unifiedLabel="Unified Table"
              groupedLabel="Grouped by Category"
            />
          )}

          {description && (
            <details className="group">
              <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none inline-flex items-center gap-1">
                <span className="transition-transform group-open:rotate-90">&#x25B6;</span>
                About this table
              </summary>
              <div className="mt-2">{description}</div>
            </details>
          )}

          {legend && (
            <details className="group">
              <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none inline-flex items-center gap-1">
                <span className="transition-transform group-open:rotate-90">&#x25B6;</span>
                Legend
              </summary>
              <div className="mt-2">{legend}</div>
            </details>
          )}
        </div>

        {/* Table */}
        {viewMode === "unified" || !grouping ? (
          <div className="overflow-x-auto">
            <DataTable
              table={table}
              getRowClassName={getRowClassName}
              stickyFirstColumn={stickyFirstColumn}
            />
          </div>
        ) : (
          <div className={grouping.headerStyle === "dark-slate" ? "space-y-6" : undefined}>
            {groupedData.map((group) => (
              <GroupedCategorySection
                key={group.key}
                label={group.label}
                description={group.description}
                data={group.data}
                columns={columns}
                columnVisibility={columnVisibility}
                headerStyle={grouping.headerStyle}
                dotClass={group.dotClass}
                dotColor={group.dotColor}
                stickyFirstColumn={stickyFirstColumn}
                getRowClassName={getRowClassName}
              />
            ))}
          </div>
        )}

        {footer}
      </div>
    </div>
  )
}
