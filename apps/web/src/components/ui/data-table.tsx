"use client"

import * as React from "react"
import type {
  Table as TanStackTable,
  Row,
  ColumnDef,
  SortingState,
  ColumnFiltersState,
} from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { Search, ChevronLeft, ChevronRight } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"

// New API: accepts table instance directly
interface DataTableWithTableProps<TData> {
  table: TanStackTable<TData>
  renderExpandedRow?: (row: Row<TData>) => React.ReactNode
  getRowClassName?: (row: Row<TData>) => string
  stickyFirstColumn?: boolean
  /** Override the outer scroll-container classes (border, max-h, etc.) */
  containerClassName?: string
}

// Legacy API: accepts data and columns (creates table internally)
interface DataTableWithDataProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  searchPlaceholder?: string
  defaultSorting?: SortingState
  renderExpandedRow?: (row: Row<TData>) => React.ReactNode
  getRowClassName?: (row: Row<TData>) => string
  /** Number of rows per page. Defaults to 100. Set to 0 to disable pagination. */
  pageSize?: number
}

type DataTableProps<TData, TValue = unknown> =
  | DataTableWithTableProps<TData>
  | DataTableWithDataProps<TData, TValue>

function isTableProps<TData>(
  props: DataTableProps<TData, unknown>
): props is DataTableWithTableProps<TData> {
  return "table" in props && props.table !== undefined
}

export function DataTable<TData, TValue = unknown>(
  props: DataTableProps<TData, TValue>
) {
  if (isTableProps(props)) {
    return <DataTableWithTable table={props.table} renderExpandedRow={props.renderExpandedRow} getRowClassName={props.getRowClassName} stickyFirstColumn={props.stickyFirstColumn} containerClassName={props.containerClassName} />
  }
  return <DataTableWithData {...(props as DataTableWithDataProps<TData, TValue>)} />
}

// New implementation: uses provided table instance
function DataTableWithTable<TData>({
  table,
  renderExpandedRow,
  getRowClassName,
  stickyFirstColumn,
  containerClassName,
}: DataTableWithTableProps<TData>) {
  const columns = table.getAllColumns()

  return (
    <div className={containerClassName ?? "rounded-lg border border-border/60 shadow-sm max-h-[80vh] overflow-auto"}>
      <Table>
        <TableHeader className="sticky top-0 z-20">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent border-b-2 border-border/60">
              {headerGroup.headers.map((header, idx) => {
                const colSize = header.column.columnDef.size
                const hasCustomSize = colSize !== undefined && colSize !== 150
                return (
                  <TableHead
                    key={header.id}
                    className={
                      stickyFirstColumn && idx === 0
                        ? "sticky left-0 z-30 bg-slate-100 dark:bg-slate-800 min-w-[180px] border-r border-border/40"
                        : undefined
                    }
                    style={hasCustomSize ? { width: colSize } : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => {
              const rowClassName = getRowClassName ? getRowClassName(row) : ""
              const expandedContent = renderExpandedRow
                ? renderExpandedRow(row)
                : null
              return (
                <React.Fragment key={row.id}>
                  <TableRow
                    data-state={row.getIsSelected() && "selected"}
                    className={rowClassName}
                  >
                    {row.getVisibleCells().map((cell, idx) => {
                      const colSize = cell.column.columnDef.size
                      const hasCustomSize = colSize !== undefined && colSize !== 150
                      return (
                        <TableCell
                          key={cell.id}
                          className={
                            stickyFirstColumn && idx === 0
                              ? "sticky left-0 z-[5] bg-white dark:bg-slate-900 border-r border-border/40"
                              : undefined
                          }
                          style={hasCustomSize ? { width: colSize } : undefined}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                  {expandedContent && (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="p-0">
                        {expandedContent}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              )
            })
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

// Legacy implementation: creates table internally (backwards compatible)
function DataTableWithData<TData, TValue>({
  columns,
  data,
  searchPlaceholder = "Search...",
  defaultSorting = [],
  renderExpandedRow,
  getRowClassName,
  pageSize = 100,
}: DataTableWithDataProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>(defaultSorting)
  const [columnFilters, setColumnFilters] =
    React.useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = React.useState("")
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: pageSize > 0 ? pageSize : data.length,
  })

  // Reset to page 1 when filter changes
  React.useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [globalFilter])

  const paginationEnabled = pageSize > 0

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    ...(paginationEnabled
      ? {
          getPaginationRowModel: getPaginationRowModel(),
          onPaginationChange: setPagination,
        }
      : {}),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: {
      sorting,
      columnFilters,
      globalFilter,
      ...(paginationEnabled ? { pagination } : {}),
    },
  })

  const filteredCount = table.getFilteredRowModel().rows.length
  const pageCount = table.getPageCount()
  const currentPage = table.getState().pagination.pageIndex + 1
  const canPrev = table.getCanPreviousPage()
  const canNext = table.getCanNextPage()

  // Page range info: "Showing 1-100 of 500"
  const { pageIndex, pageSize: ps } = table.getState().pagination
  const rangeStart = pageIndex * ps + 1
  const rangeEnd = Math.min((pageIndex + 1) * ps, filteredCount)

  return (
    <div className="space-y-4">
      {/* Search + row count */}
      <div className="flex items-center gap-4 pb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder={searchPlaceholder}
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filteredCount === data.length
            ? `${data.length} results`
            : `${filteredCount} of ${data.length} results`}
        </span>
      </div>

      {/* Table */}
      <DataTableWithTable
        table={table}
        renderExpandedRow={renderExpandedRow}
        getRowClassName={getRowClassName}
      />

      {/* Pagination controls (only shown when pagination is enabled and there are multiple pages) */}
      {paginationEnabled && pageCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-sm text-muted-foreground">
            Showing {rangeStart}–{rangeEnd} of {filteredCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!canPrev}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <span className="px-2 text-xs text-muted-foreground tabular-nums">
              {currentPage} / {pageCount}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!canNext}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Re-export SortableHeader from dedicated file
export { SortableHeader } from "./sortable-header"
