"use client";

import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useServerTable } from "@/hooks/use-server-table";

// ── Types ────────────────────────────────────────────────────────────

export interface ColumnDef<T> {
  id: string;
  header: string;
  accessor: (row: T) => ReactNode;
  /** Maps to server sort field name. undefined = not sortable */
  sortField?: string;
  /** Whether to show the column by default (default: true) */
  defaultVisible?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
}

export type SortDir = "asc" | "desc";

export interface ServerPaginatedTableProps<T> {
  columns: ColumnDef<T>[];
  // Static mode
  rows?: T[];
  totalCount?: number;
  /** Keys of T to include in text search (static mode). If omitted, searches JSON. */
  searchFields?: (keyof T)[];
  // Server mode — presence of `endpoint` triggers server mode
  endpoint?: string;
  transform?: (json: unknown) => { rows: T[]; total: number };
  // Shared config
  rowKey: (row: T) => string;
  pageSize?: number;
  defaultSortId?: string;
  defaultSortDir?: SortDir;
  searchPlaceholder?: string;
  /** Label for items (e.g., "grants", "organizations") */
  itemLabel?: string;
  showColumnPicker?: boolean;
  emptyMessage?: string;
  loadingMessage?: string;
  /** Custom comparator for static mode. If omitted, sorts by accessor return value. */
  staticSort?: (a: T, b: T, sortId: string, dir: SortDir) => number;
}

const DEFAULT_PAGE_SIZE = 50;
const EMPTY_ROWS: never[] = [];

// ── Component ────────────────────────────────────────────────────────

export function ServerPaginatedTable<T>({
  columns, rows: staticRows, totalCount, searchFields,
  endpoint, transform,
  rowKey, pageSize = DEFAULT_PAGE_SIZE,
  defaultSortId, defaultSortDir = "desc",
  searchPlaceholder = "Search...", itemLabel = "items",
  showColumnPicker = true, emptyMessage = "No results.",
  loadingMessage = "Loading...", staticSort,
}: ServerPaginatedTableProps<T>) {
  const serverMode = !!endpoint;

  const defaultSortField = (() => {
    if (!defaultSortId) return "id";
    const col = columns.find((c) => c.id === defaultSortId);
    return col?.sortField ?? defaultSortId;
  })();

  // Hook always called for consistent hook order
  const server = useServerTable<T>({
    endpoint: endpoint ?? "",
    defaultPageSize: pageSize,
    defaultSort: { field: defaultSortField, dir: defaultSortDir },
    transform: transform ?? (() => ({ rows: [], total: 0 })),
    enabled: serverMode,
  });

  // Destructure stable method refs to avoid re-creating callbacks when `server` object identity changes
  const { setSearch: serverSetSearch, setSort: serverSetSort, setPage: serverSetPage } = server;

  // ── Static-mode state ──
  const [localSearch, setLocalSearch] = useState("");
  const [localSortId, setLocalSortId] = useState(defaultSortId ?? "");
  const [localSortDir, setLocalSortDir] = useState<SortDir>(defaultSortDir);
  const [localPage, setLocalPage] = useState(0);
  const allRows = (staticRows ?? EMPTY_ROWS) as T[];

  const localFiltered = useMemo(() => {
    if (serverMode || !localSearch.trim()) return allRows;
    const q = localSearch.toLowerCase();
    if (!searchFields || searchFields.length === 0) {
      return allRows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
    }
    return allRows.filter((row) =>
      searchFields.some((field) => {
        const val = row[field];
        return val != null && String(val).toLowerCase().includes(q);
      }),
    );
  }, [serverMode, allRows, localSearch, searchFields]);

  const localSorted = useMemo(() => {
    if (serverMode || !localSortId) return localFiltered;
    const arr = [...localFiltered];
    if (staticSort) {
      arr.sort((a, b) => staticSort(a, b, localSortId, localSortDir));
      return arr;
    }
    const col = columns.find((c) => c.id === localSortId);
    if (!col) return arr;
    arr.sort((a, b) => {
      const aVal = col.accessor(a);
      const bVal = col.accessor(b);
      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
      }
      return localSortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [serverMode, localFiltered, localSortId, localSortDir, columns, staticSort]);

  const localTotalPages = Math.max(1, Math.ceil(localSorted.length / pageSize));
  const localSafePage = Math.min(localPage, localTotalPages - 1);
  const localPageRows = serverMode
    ? (EMPTY_ROWS as T[])
    : localSorted.slice(localSafePage * pageSize, (localSafePage + 1) * pageSize);

  // ── Unified interface ──
  const rows = serverMode ? server.data : localPageRows;
  const search = serverMode ? server.search : localSearch;
  const sortId = serverMode ? findColumnIdByField(columns, server.sort.field) : localSortId;
  const sortDir: SortDir = serverMode ? (server.sort.dir as SortDir) : localSortDir;
  const currentPage = serverMode ? server.meta.page - 1 : localSafePage;
  const totalPages = serverMode ? server.meta.pageCount : localTotalPages;
  const displayTotal = serverMode ? server.meta.total : totalCount ?? allRows.length;
  const filteredTotal = serverMode ? server.meta.total : localFiltered.length;
  const isLoading = serverMode ? server.isLoading : false;
  const isInitialLoad = serverMode && server.isLoading && server.data.length === 0;

  const handleSearch = useCallback((value: string) => {
    if (serverMode) { serverSetSearch(value); }
    else { setLocalSearch(value); setLocalPage(0); }
  }, [serverMode, serverSetSearch]);

  const handleSort = useCallback((colId: string) => {
    const col = columns.find((c) => c.id === colId);
    if (!col) return;
    if (serverMode) {
      if (col.sortField) serverSetSort(col.sortField);
    } else {
      if (localSortId === colId) {
        setLocalSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setLocalSortId(colId);
        setLocalSortDir(defaultSortDir);
      }
      setLocalPage(0);
    }
  }, [columns, serverMode, serverSetSort, localSortId, defaultSortDir]);

  const handlePageChange = useCallback((p: number) => {
    if (serverMode) { serverSetPage(p + 1); } // hook uses 1-indexed pages
    else { setLocalPage(p); }
  }, [serverMode, serverSetPage]);

  // ── Column visibility ──
  const [showPicker, setShowPicker] = useState(false);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const col of columns) { if (col.defaultVisible !== false) s.add(col.id); }
    return s;
  });

  const toggleColumn = useCallback((colId: string) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }, []);

  const activeCols = useMemo(
    () => columns.filter((c) => visibleCols.has(c.id)),
    [columns, visibleCols],
  );

  const isSortable = useCallback(
    (col: ColumnDef<T>) => serverMode ? !!col.sortField : (!!col.sortField || !!staticSort),
    [serverMode, staticSort],
  );

  // ── Status text ──
  const statusText = (() => {
    if (serverMode) return isLoading ? loadingMessage : `${displayTotal} ${itemLabel}`;
    const shown = filteredTotal === allRows.length
      ? `${allRows.length} ${itemLabel}`
      : `${filteredTotal} of ${allRows.length} ${itemLabel}`;
    const truncated = (totalCount ?? allRows.length) > allRows.length;
    return truncated ? `${shown} (top ${allRows.length} of ${totalCount})` : shown;
  })();

  const alignCls = (a?: "left" | "right" | "center") =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
          />
          {search && (
            <button
              type="button"
              onClick={() => handleSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
            >
              {"\u2715"}
            </button>
          )}
        </div>

        {showColumnPicker && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowPicker((v) => !v)}
              className="px-3 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted/50 transition-colors text-muted-foreground"
            >
              Columns ({activeCols.length})
            </button>
            {showPicker && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 min-w-[160px]">
                {columns.map((col) => (
                  <label key={col.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted/50 rounded cursor-pointer">
                    <input type="checkbox" checked={visibleCols.has(col.id)} onChange={() => toggleColumn(col.id)} className="rounded" />
                    {col.header}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <span className="text-xs text-muted-foreground ml-auto">{statusText}</span>
      </div>

      {/* Table */}
      <div className="border border-border/60 rounded-xl overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {activeCols.map((col) => {
                const sortable = isSortable(col);
                return (
                  <th
                    key={col.id}
                    scope="col"
                    className={`py-2.5 px-4 font-medium select-none whitespace-nowrap ${
                      sortable ? "cursor-pointer hover:text-foreground" : "cursor-default"
                    } transition-colors ${alignCls(col.align)}`}
                    onClick={sortable ? () => handleSort(col.id) : undefined}
                  >
                    {col.header}
                    <SortIndicator active={sortId === col.id} dir={sortDir} sortable={sortable} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {isInitialLoad ? (
              <tr>
                <td colSpan={activeCols.length} className="py-8 text-center text-muted-foreground text-sm">
                  {loadingMessage}
                </td>
              </tr>
            ) : (
              <>
                {rows.map((row) => (
                  <tr key={rowKey(row)} className={`hover:bg-muted/20 transition-colors ${isLoading ? "opacity-50" : ""}`}>
                    {activeCols.map((col) => (
                      <td key={col.id} className={`py-2.5 px-4 text-sm ${alignCls(col.align)} ${col.className ?? ""}`}>
                        {col.accessor(row)}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={activeCols.length} className="py-8 text-center text-muted-foreground text-sm">
                      {search ? `No ${itemLabel} match your search.` : emptyMessage}
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {currentPage + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <PageBtn disabled={currentPage === 0} onClick={() => handlePageChange(0)}>First</PageBtn>
            <PageBtn disabled={currentPage === 0} onClick={() => handlePageChange(Math.max(0, currentPage - 1))}>Prev</PageBtn>
            <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => handlePageChange(Math.min(totalPages - 1, currentPage + 1))}>Next</PageBtn>
            <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => handlePageChange(totalPages - 1)}>Last</PageBtn>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper components ────────────────────────────────────────────────

function SortIndicator({ active, dir, sortable }: { active: boolean; dir: SortDir; sortable: boolean }) {
  if (!sortable) return null;
  if (!active) return <span className="text-muted-foreground/30 ml-1">{"\u2195"}</span>;
  return <span className="text-primary ml-1">{dir === "asc" ? "\u2191" : "\u2193"}</span>;
}

function PageBtn({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" disabled={disabled} onClick={onClick}
      className="px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function findColumnIdByField<T>(columns: ColumnDef<T>[], field: string): string {
  const col = columns.find((c) => c.sortField === field);
  return col?.id ?? field;
}
