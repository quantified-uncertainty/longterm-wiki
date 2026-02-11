"use client"

import { useState, useMemo, useRef, useEffect, type ReactNode } from "react"
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
import { X } from "lucide-react"
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
                  ? "bg-muted text-foreground font-medium"
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

        {/* Controls row: view mode toggle + info toggles */}
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
            <ExpandableInfo label="About this table">
              {description}
            </ExpandableInfo>
          )}

          {legend && (
            <ExpandableInfo label="Legend">
              {legend}
            </ExpandableInfo>
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

/** Inline toggle that reveals content in a dropdown panel below the trigger row */
function ExpandableInfo({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "text-xs font-medium cursor-pointer select-none inline-flex items-center gap-1 px-2 py-1 rounded-md transition-colors",
          open
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
      >
        <span className={cn("text-[10px] transition-transform", open && "rotate-90")}>&#x25B6;</span>
        {label}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-[min(600px,90vw)] rounded-lg border border-border bg-background shadow-lg p-4">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="text-sm pr-6">{children}</div>
        </div>
      )}
    </div>
  )
}
