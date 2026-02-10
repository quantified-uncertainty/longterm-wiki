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
import { DataTable } from "@/components/ui/data-table"
import { TableViewHeader } from "./TableViewHeader"
import { ColumnToggleControls } from "./ColumnToggleControls"
import { ViewModeToggle, type ViewMode } from "./ViewModeToggle"
import { useColumnVisibility, type ColumnConfig } from "./useColumnVisibility"
import {
  GroupedCategorySection,
  type GroupHeaderStyle,
} from "./GroupedCategorySection"

interface Breadcrumb {
  label: string
  href: string
}

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
  /** Tailwind class for dots keyed by group key (colored-dot style) */
  groupDotClasses?: Record<string, string>
  /** CSS hex colors for dots keyed by group key (inline-color style) */
  groupDotColors?: Record<string, string>
  hideCategoryColumnInGroupedMode?: boolean
  categoryColumnId?: string
}

export interface TableViewConfig<TData, TColumnKey extends string> {
  // Page layout
  title: string
  breadcrumbs: Breadcrumb[]
  navLinks?: NavLink[]

  // Data + columns
  data: TData[]
  createColumns: () => ColumnDef<TData>[]
  columnConfig: Record<TColumnKey, ColumnConfig>
  columnPresets: Record<string, TColumnKey[]>
  pinnedColumn?: string

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
  title,
  breadcrumbs,
  navLinks,
  data,
  createColumns,
  columnConfig,
  columnPresets,
  pinnedColumn,
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
    // Pinned column is always visible (set after loop so it can't be overwritten)
    if (pinnedColumn) {
      visibility[pinnedColumn] = true
    }
    // Hide category column in grouped mode if configured
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
    <div className={className ?? "min-h-screen flex flex-col bg-background"}>
      <TableViewHeader
        title={title}
        breadcrumbs={breadcrumbs}
        navLinks={navLinks}
      />

      <div className="p-4 space-y-4">
        {aboveControls}

        <ColumnToggleControls
          columns={columnConfig}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          presets={columnPresets}
          applyPreset={applyPreset}
        />

        {description}

        {grouping && (
          <ViewModeToggle
            viewMode={viewMode}
            setViewMode={setViewMode}
            unifiedLabel="Unified Table"
            groupedLabel="Grouped by Category"
          />
        )}

        {legend}

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
