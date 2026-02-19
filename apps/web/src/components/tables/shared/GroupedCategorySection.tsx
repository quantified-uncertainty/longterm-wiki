"use client"

import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
  type VisibilityState,
  type Row,
} from "@tanstack/react-table"
import { DataTable } from "@/components/ui/data-table"
import { cn } from "@/lib/utils"

export type GroupHeaderStyle =
  | "colored-dot"
  | "inline-color"
  | "dark-slate"
  | "purple-dot"

interface GroupedCategorySectionProps<TData> {
  label: string
  description?: string
  data: TData[]
  columns: ColumnDef<TData>[]
  columnVisibility: VisibilityState
  headerStyle: GroupHeaderStyle
  /** Tailwind class for the dot (used with colored-dot) */
  dotClass?: string
  /** CSS hex color for the dot (used with inline-color) */
  dotColor?: string
  stickyFirstColumn?: boolean
  getRowClassName?: (row: Row<TData>) => string
}

export function GroupedCategorySection<TData>({
  label,
  description,
  data,
  columns,
  columnVisibility,
  headerStyle,
  dotClass,
  dotColor,
  stickyFirstColumn,
  getRowClassName,
}: GroupedCategorySectionProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  })

  if (data.length === 0) return null

  return (
    <div className="space-y-2 mb-8">
      <GroupHeader
        style={headerStyle}
        label={label}
        description={description}
        dotClass={dotClass}
        dotColor={dotColor}
      />
      <div className="overflow-x-auto">
        <DataTable table={table} stickyFirstColumn={stickyFirstColumn} getRowClassName={getRowClassName} />
      </div>
    </div>
  )
}

function GroupHeader({
  style,
  label,
  description,
  dotClass,
  dotColor,
}: {
  style: GroupHeaderStyle
  label: string
  description?: string
  dotClass?: string
  dotColor?: string
}) {
  switch (style) {
    case "dark-slate":
      return (
        <div className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 px-4 py-2 rounded-t-md font-semibold text-sm uppercase tracking-wide">
          {label}
          {description && ` — ${description}`}
        </div>
      )
    case "inline-color":
      return (
        <div className="flex items-center gap-3 pb-2 border-b-2 border-border">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
          />
          <div className="text-base font-semibold text-foreground">{label}</div>
        </div>
      )
    case "purple-dot":
      return (
        <div className="flex items-center gap-3 pb-2 border-b-2 border-border">
          <div className="w-3 h-3 rounded-full shrink-0 bg-purple-500" />
          <div className="text-base font-semibold text-foreground uppercase tracking-wide">
            {label}
          </div>
        </div>
      )
    case "colored-dot":
    default:
      return (
        <div className="flex items-center gap-3 pb-2 border-b-2 border-border">
          <div className={cn("w-3 h-3 rounded-full shrink-0", dotClass)} />
          <div className="text-base font-semibold text-foreground">{label}</div>
          {description && (
            <div className="text-sm text-muted-foreground">
              — {description}
            </div>
          )}
        </div>
      )
  }
}
