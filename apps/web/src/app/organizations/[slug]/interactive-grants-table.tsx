"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { useServerTable } from "@/hooks/use-server-table";

// ── Serializable grant row (no JSX, no functions — pure JSON) ───────

export interface GrantRow {
  key: string;
  name: string;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null; // single numeric value for sorting (midpoint for ranges)
  amountDisplay: string | null; // pre-formatted display string
  date: string | null;
  status: string | null;
  source: string | null;
  programName: string | null;
  divisionName: string | null;
  notes: string | null;
  // For grants received:
  funderName?: string;
  funderHref?: string | null;
}

// ── Server grant shape (from wiki-server API) ───────────────────────

interface ServerGrant {
  id: string;
  granteeId: string | null;
  name: string;
  amount: number | null;
  period: string | null;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
  programId: string | null;
}

function formatSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function serverGrantToRow(g: ServerGrant): GrantRow {
  return {
    key: g.id,
    name: g.name,
    recipientName: g.granteeId ? formatSlug(g.granteeId) : "Unknown",
    recipientHref: g.granteeId ? `/organizations/${g.granteeId}` : null,
    amount: g.amount,
    amountDisplay: g.amount != null ? formatCompactCurrency(g.amount) : null,
    date: g.date ?? g.period ?? null,
    status: g.status,
    source: g.source,
    programName: g.programId ? formatSlug(g.programId) : null,
    divisionName: null,
    notes: g.notes,
  };
}

// Module-level transform — stable reference, no re-renders
function transformGrantsResponse(json: unknown): {
  rows: GrantRow[];
  total: number;
} {
  const data = json as { grants?: ServerGrant[]; total?: number };
  return {
    rows: (data.grants ?? []).map(serverGrantToRow),
    total: data.total ?? 0,
  };
}

// Stable empty array constant — avoids new reference on every render in server mode
const EMPTY_GRANTS: GrantRow[] = [];

// ── Column definitions ──────────────────────────────────────────────

type ColumnId =
  | "name"
  | "recipient"
  | "funder"
  | "amount"
  | "date"
  | "program"
  | "division"
  | "status"
  | "notes";

// Map column IDs to server sort field names
const COLUMN_TO_SORT_FIELD: Partial<Record<ColumnId, string>> = {
  name: "name",
  recipient: "recipient",
  amount: "amount",
  date: "date",
};

interface ColumnDef {
  id: ColumnId;
  label: string;
  defaultVisible: boolean;
  align?: "left" | "right" | "center";
  /** Only include this column when the data has any non-null values */
  onlyIfData?: (rows: GrantRow[]) => boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
  { id: "name", label: "Grant", defaultVisible: true, align: "left" },
  {
    id: "recipient",
    label: "Recipient",
    defaultVisible: true,
    align: "left",
    onlyIfData: (rows) => rows.some((r) => r.recipientName),
  },
  {
    id: "funder",
    label: "Funder",
    defaultVisible: true,
    align: "left",
    onlyIfData: (rows) => rows.some((r) => r.funderName),
  },
  { id: "amount", label: "Amount", defaultVisible: true, align: "right" },
  { id: "date", label: "Date", defaultVisible: true, align: "center" },
  {
    id: "program",
    label: "Program",
    defaultVisible: false,
    align: "left",
    onlyIfData: (rows) => rows.some((r) => r.programName),
  },
  {
    id: "division",
    label: "Division",
    defaultVisible: true,
    align: "left",
    onlyIfData: (rows) => rows.some((r) => r.divisionName),
  },
  {
    id: "status",
    label: "Status",
    defaultVisible: false,
    align: "center",
    onlyIfData: (rows) => rows.some((r) => r.status),
  },
  {
    id: "notes",
    label: "Notes",
    defaultVisible: false,
    align: "left",
    onlyIfData: (rows) => rows.some((r) => r.notes),
  },
];

type SortDir = "asc" | "desc";

const PAGE_SIZE = 50;

// ── Component ───────────────────────────────────────────────────────

export function InteractiveGrantsTable({
  grants: staticGrants,
  totalCount: staticTotalCount,
  entityId,
  mode = "given",
}: {
  grants?: GrantRow[];
  /** Total count including any not serialized */
  totalCount?: number;
  /** When provided, enables server-side search/sort/pagination */
  entityId?: string;
  mode?: "given" | "received";
}) {
  const serverMode = !!entityId;

  // ── Server-side state (hook always called for consistent hook order) ──
  const server = useServerTable<GrantRow>({
    endpoint: `/api/grants/by-entity/${entityId ?? ""}`,
    defaultPageSize: PAGE_SIZE,
    defaultSort: { field: "amount", dir: "desc" },
    transform: transformGrantsResponse,
    enabled: serverMode,
  });

  // ── Static-mode state ──
  const [localSearch, setLocalSearch] = useState("");
  const [localSortCol, setLocalSortCol] = useState<ColumnId>("amount");
  const [localSortDir, setLocalSortDir] = useState<SortDir>("desc");
  const [localPage, setLocalPage] = useState(0);

  const allGrants = staticGrants ?? EMPTY_GRANTS;

  // Static-mode: filter
  const localFiltered = useMemo(() => {
    if (serverMode || !localSearch.trim()) return allGrants;
    const q = localSearch.toLowerCase();
    return allGrants.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.recipientName.toLowerCase().includes(q) ||
        (g.funderName?.toLowerCase().includes(q) ?? false) ||
        (g.programName?.toLowerCase().includes(q) ?? false) ||
        (g.divisionName?.toLowerCase().includes(q) ?? false) ||
        (g.notes?.toLowerCase().includes(q) ?? false),
    );
  }, [serverMode, allGrants, localSearch]);

  // Static-mode: sort
  const localSorted = useMemo(() => {
    if (serverMode) return localFiltered;
    const arr = [...localFiltered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (localSortCol) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "recipient":
          cmp = a.recipientName.localeCompare(b.recipientName);
          break;
        case "funder":
          cmp = (a.funderName ?? "").localeCompare(b.funderName ?? "");
          break;
        case "amount":
          cmp = (a.amount ?? 0) - (b.amount ?? 0);
          break;
        case "date":
          cmp = (a.date ?? "").localeCompare(b.date ?? "");
          break;
        case "program":
          cmp = (a.programName ?? "").localeCompare(b.programName ?? "");
          break;
        case "division":
          cmp = (a.divisionName ?? "").localeCompare(b.divisionName ?? "");
          break;
        case "status":
          cmp = (a.status ?? "").localeCompare(b.status ?? "");
          break;
        case "notes":
          cmp = (a.notes ?? "").localeCompare(b.notes ?? "");
          break;
      }
      return localSortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [serverMode, localFiltered, localSortCol, localSortDir]);

  // Static-mode: paginate
  const localTotalPages = Math.max(
    1,
    Math.ceil(localSorted.length / PAGE_SIZE),
  );
  const localSafePage = Math.min(localPage, localTotalPages - 1);
  const localPageRows = serverMode
    ? []
    : localSorted.slice(
        localSafePage * PAGE_SIZE,
        (localSafePage + 1) * PAGE_SIZE,
      );

  // ── Unified interface ──
  const rows = serverMode ? server.data : localPageRows;
  const search = serverMode ? server.search : localSearch;
  const sortCol: ColumnId = serverMode
    ? (server.sort.field as ColumnId)
    : localSortCol;
  const sortDir: SortDir = serverMode
    ? (server.sort.dir as SortDir)
    : localSortDir;
  const currentPage = serverMode ? server.meta.page - 1 : localSafePage; // 0-indexed for display
  const totalPages = serverMode ? server.meta.pageCount : localTotalPages;
  const displayTotal = serverMode
    ? server.meta.total
    : staticTotalCount ?? allGrants.length;
  const filteredTotal = serverMode ? server.meta.total : localFiltered.length;
  // In server mode, treat initial state (no data yet) as loading
  const isLoading = serverMode
    ? server.isLoading || (server.data.length === 0 && !server.error)
    : false;

  const handleSearch = (value: string) => {
    if (serverMode) {
      server.setSearch(value);
    } else {
      setLocalSearch(value);
      setLocalPage(0);
    }
  };

  const handleSort = (col: ColumnId) => {
    if (serverMode) {
      const sortField = COLUMN_TO_SORT_FIELD[col];
      if (sortField) {
        server.setSort(sortField);
      }
    } else {
      if (localSortCol === col) {
        setLocalSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setLocalSortCol(col);
        setLocalSortDir(col === "amount" ? "desc" : "asc");
      }
      setLocalPage(0);
    }
  };

  const handlePageChange = (p: number) => {
    if (serverMode) {
      server.setPage(p + 1); // hook uses 1-indexed pages
    } else {
      setLocalPage(p);
    }
  };

  // ── Column visibility ──
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  // For server mode, use a fixed set of available columns (we don't have all data to check)
  const availableColumns = useMemo(() => {
    const dataToCheck = serverMode ? rows : allGrants;
    return ALL_COLUMNS.filter((col) => {
      if (mode === "given" && col.id === "funder") return false;
      if (mode === "received" && col.id === "recipient") return false;
      // In server mode, show all applicable columns; in static mode, check data
      if (!serverMode && col.onlyIfData && !col.onlyIfData(dataToCheck))
        return false;
      // In server mode, hide division (not available from server) and hide
      // columns that wouldn't have data based on mode
      if (serverMode && col.id === "division") return false;
      return true;
    });
  }, [serverMode, rows, allGrants, mode]);

  const [visibleCols, setVisibleCols] = useState<Set<ColumnId>>(() => {
    const initial = new Set<ColumnId>();
    for (const col of ALL_COLUMNS) {
      if (col.defaultVisible) initial.add(col.id);
    }
    return initial;
  });

  const toggleColumn = (col: ColumnId) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  };

  const activeCols = availableColumns.filter((c) => visibleCols.has(c.id));

  /** Whether a column supports server-side sorting */
  const isSortable = (col: ColumnId) =>
    !serverMode || !!COLUMN_TO_SORT_FIELD[col];

  const sortIndicator = (col: ColumnId) => {
    if (!isSortable(col)) return null;
    if (sortCol !== col)
      return (
        <span className="text-muted-foreground/30 ml-1">{"\u2195"}</span>
      );
    return (
      <span className="text-primary ml-1">
        {sortDir === "asc" ? "\u2191" : "\u2193"}
      </span>
    );
  };

  // ── Status text ──
  const statusText = (() => {
    if (serverMode) {
      if (isLoading) return "Loading...";
      return `${displayTotal} grants`;
    }
    const shown = filteredTotal === allGrants.length
      ? `${allGrants.length} grants`
      : `${filteredTotal} of ${allGrants.length} grants`;
    const truncated =
      (staticTotalCount ?? allGrants.length) > allGrants.length;
    return truncated
      ? `${shown} (top ${allGrants.length} of ${staticTotalCount} by amount)`
      : shown;
  })();

  return (
    <div className="space-y-3">
      {/* Toolbar: search + column picker */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <input
            type="text"
            placeholder="Search grants..."
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

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowColumnPicker((v) => !v)}
            className="px-3 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted/50 transition-colors text-muted-foreground"
          >
            Columns ({activeCols.length})
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 min-w-[160px]">
              {availableColumns.map((col) => (
                <label
                  key={col.id}
                  className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted/50 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleCols.has(col.id)}
                    onChange={() => toggleColumn(col.id)}
                    className="rounded"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-muted-foreground ml-auto">
          {statusText}
        </span>
      </div>

      {/* Table */}
      <div className="border border-border/60 rounded-xl overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {activeCols.map((col) => {
                const sortable = isSortable(col.id);
                return (
                  <th
                    key={col.id}
                    scope="col"
                    className={`py-2.5 px-4 font-medium select-none whitespace-nowrap ${
                      sortable
                        ? "cursor-pointer hover:text-foreground"
                        : "cursor-default"
                    } transition-colors ${
                      col.align === "right"
                        ? "text-right"
                        : col.align === "center"
                          ? "text-center"
                          : "text-left"
                    }`}
                    onClick={sortable ? () => handleSort(col.id) : undefined}
                  >
                    {col.label}
                    {sortIndicator(col.id)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {isLoading && rows.length === 0 ? (
              <tr>
                <td
                  colSpan={activeCols.length}
                  className="py-8 text-center text-muted-foreground text-sm"
                >
                  Loading grants...
                </td>
              </tr>
            ) : (
              <>
                {rows.map((g) => (
                  <tr
                    key={g.key}
                    className={`hover:bg-muted/20 transition-colors ${isLoading ? "opacity-50" : ""}`}
                  >
                    {activeCols.map((col) => (
                      <td
                        key={col.id}
                        className={`py-2.5 px-4 text-sm ${
                          col.align === "right"
                            ? "text-right"
                            : col.align === "center"
                              ? "text-center"
                              : ""
                        }`}
                      >
                        <CellContent grant={g} column={col.id} />
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={activeCols.length}
                      className="py-8 text-center text-muted-foreground text-sm"
                    >
                      {search
                        ? "No grants match your search."
                        : "No grants."}
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
          <span>
            Page {currentPage + 1} of {totalPages}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => handlePageChange(0)}
              className="px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              First
            </button>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => handlePageChange(Math.max(0, currentPage - 1))}
              className="px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages - 1}
              onClick={() =>
                handlePageChange(Math.min(totalPages - 1, currentPage + 1))
              }
              className="px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages - 1}
              onClick={() => handlePageChange(totalPages - 1)}
              className="px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Last
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cell rendering ──────────────────────────────────────────────────

function CellContent({
  grant,
  column,
}: {
  grant: GrantRow;
  column: ColumnId;
}) {
  switch (column) {
    case "name":
      return (
        <span>
          <span className="font-medium text-foreground">{grant.name}</span>
          {grant.source && (
            <a
              href={grant.source}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
            >
              source
            </a>
          )}
        </span>
      );
    case "recipient":
      return grant.recipientHref ? (
        <Link
          href={grant.recipientHref}
          className="text-primary hover:underline"
        >
          {grant.recipientName}
        </Link>
      ) : (
        <span className="text-muted-foreground">{grant.recipientName}</span>
      );
    case "funder":
      return grant.funderHref ? (
        <Link
          href={grant.funderHref}
          className="text-primary hover:underline"
        >
          {grant.funderName}
        </Link>
      ) : (
        <span className="text-muted-foreground">
          {grant.funderName ?? ""}
        </span>
      );
    case "amount":
      return grant.amountDisplay ? (
        <span className="font-semibold tabular-nums whitespace-nowrap">
          {grant.amountDisplay}
        </span>
      ) : null;
    case "date":
      return (
        <span className="text-muted-foreground">{grant.date ?? ""}</span>
      );
    case "program":
      return (
        <span className="text-muted-foreground text-xs">
          {grant.programName ?? ""}
        </span>
      );
    case "division":
      return (
        <span className="text-muted-foreground text-xs">
          {grant.divisionName ?? ""}
        </span>
      );
    case "status":
      return grant.status ? (
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
            grant.status === "active"
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
              : grant.status === "completed"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {grant.status}
        </span>
      ) : null;
    case "notes":
      return grant.notes ? (
        <span className="text-muted-foreground text-xs line-clamp-2">
          {grant.notes}
        </span>
      ) : null;
    default:
      return null;
  }
}
