"use client";

import { useState, useMemo, useCallback, type ReactNode } from "react";
import {
  Search,
  Columns3,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortDir = "asc" | "desc";

export interface ColumnDef<T> {
  id: string;
  header: string;
  accessor: (row: T) => ReactNode;
  /** If defined, this column is sortable. The value is the sort field key passed to staticSort. */
  sortField?: string;
  /** Whether the column is visible by default. Default: true */
  defaultVisible?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
}

export interface ServerPaginatedTableProps<T> {
  columns: ColumnDef<T>[];
  rows?: T[];
  totalCount?: number;
  /** Fields on T to search across (client-side text search) */
  searchFields?: (keyof T)[];
  /** Unique key extractor for each row */
  rowKey: (row: T) => string;
  pageSize?: number;
  defaultSortId?: string;
  defaultSortDir?: SortDir;
  searchPlaceholder?: string;
  itemLabel?: string;
  showColumnPicker?: boolean;
  emptyMessage?: string;
  /** Client-side sort comparator. Required for sorting to work in static mode. */
  staticSort?: (a: T, b: T, sortId: string, dir: SortDir) => number;
  /** Sticky first column */
  stickyFirstColumn?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ServerPaginatedTable<T>({
  columns,
  rows = [],
  totalCount,
  searchFields,
  rowKey,
  pageSize = 50,
  defaultSortId,
  defaultSortDir = "asc",
  searchPlaceholder = "Search...",
  itemLabel = "items",
  showColumnPicker = true,
  emptyMessage = "No results.",
  staticSort,
  stickyFirstColumn,
}: ServerPaginatedTableProps<T>) {
  const [search, setSearch] = useState("");
  const [sortId, setSortId] = useState<string | undefined>(defaultSortId);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSortDir);
  const [page, setPage] = useState(0);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    const hidden = new Set<string>();
    for (const col of columns) {
      if (col.defaultVisible === false) {
        hidden.add(col.id);
      }
    }
    return hidden;
  });

  // Visible columns
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenColumns.has(c.id)),
    [columns, hiddenColumns]
  );

  // Search filter
  const searched = useMemo(() => {
    if (!search.trim() || !searchFields || searchFields.length === 0)
      return rows;
    const q = search.toLowerCase();
    return rows.filter((row) =>
      searchFields.some((field) => {
        const val = row[field];
        if (val == null) return false;
        return String(val).toLowerCase().includes(q);
      })
    );
  }, [rows, search, searchFields]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortId || !staticSort) return searched;
    return [...searched].sort((a, b) => staticSort(a, b, sortId, sortDir));
  }, [searched, sortId, sortDir, staticSort]);

  // Pagination
  const total = totalCount ?? sorted.length;
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const startIdx = safePage * pageSize;
  const pageRows = sorted.slice(startIdx, startIdx + pageSize);
  const rangeStart = sorted.length > 0 ? startIdx + 1 : 0;
  const rangeEnd = Math.min(startIdx + pageSize, sorted.length);

  const toggleSort = useCallback(
    (field: string) => {
      if (sortId === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortId(field);
        setSortDir("asc");
      }
      setPage(0);
    },
    [sortId]
  );

  const toggleColumn = useCallback((colId: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) {
        next.delete(colId);
      } else {
        next.add(colId);
      }
      return next;
    });
  }, []);

  const alignClass = (align?: "left" | "right" | "center") => {
    if (align === "right") return "text-right";
    if (align === "center") return "text-center";
    return "text-left";
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        {searchFields && searchFields.length > 0 && (
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </div>
        )}

        {/* Column picker */}
        {showColumnPicker && (
          <div className="relative">
            <button
              onClick={() => setColumnPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-md bg-background text-muted-foreground hover:bg-muted transition-colors"
            >
              <Columns3 className="h-3.5 w-3.5" />
              Columns
            </button>
            {columnPickerOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[240px] max-h-[60vh] overflow-y-auto">
                {columns.map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.has(col.id)}
                      onChange={() => toggleColumn(col.id)}
                      className="rounded"
                    />
                    {col.header}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Count */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {searched.length === rows.length
            ? `${total} ${itemLabel}`
            : `${searched.length} of ${total} ${itemLabel}`}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 shadow-sm max-h-[80vh] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-20">
            <TableRow className="hover:bg-transparent border-b-2 border-border/60">
              {visibleColumns.map((col, idx) => (
                <TableHead
                  key={col.id}
                  className={`${alignClass(col.align)} ${
                    stickyFirstColumn && idx === 0
                      ? "sticky left-0 z-30 bg-slate-100 dark:bg-slate-800 min-w-[180px] border-r border-border/40"
                      : ""
                  } ${col.className ?? ""}`}
                >
                  {col.sortField ? (
                    <button
                      onClick={() => toggleSort(col.sortField!)}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      {col.header}
                      {sortId === col.sortField ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length > 0 ? (
              pageRows.map((row) => (
                <TableRow key={rowKey(row)}>
                  {visibleColumns.map((col, idx) => (
                    <TableCell
                      key={col.id}
                      className={`${alignClass(col.align)} ${
                        stickyFirstColumn && idx === 0
                          ? "sticky left-0 z-[5] bg-white dark:bg-slate-900 border-r border-border/40"
                          : ""
                      } ${col.className ?? ""}`}
                    >
                      {col.accessor(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={visibleColumns.length}
                  className="h-24 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Rows per page:</span>
            <select
              value={pageSize}
              disabled
              className="h-7 rounded border border-border bg-background px-2 text-xs opacity-60"
            >
              <option value={pageSize}>{pageSize}</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {rangeStart}-{rangeEnd} of {sorted.length}
            </span>
            <button
              onClick={() => setPage(0)}
              disabled={safePage === 0}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage(pageCount - 1)}
              disabled={safePage >= pageCount - 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
