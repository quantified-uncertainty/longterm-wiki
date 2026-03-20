"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import { STATUS_COLORS, SCOPE_COLORS, normalizeStatus } from "./legislation-constants";
import { formatIntroducedDate } from "@/lib/format-compact";

export interface LegislationRow {
  id: string;
  title: string;
  wikiId: string | null;
  introduced: string | null;
  policyStatus: string | null;
  /** Normalized status key for badge color. */
  statusKey: string | null;
  author: string | null;
  scope: string | null;
  /** Specific geographic jurisdiction (e.g., "California", "European Union"). */
  jurisdiction: string | null;
  /** Bill number (e.g., "SB 1047", "EO 14110"). */
  billNumber: string | null;
  /** URL to official full text (gov site). */
  fullTextUrl: string | null;
  /** Most recent action label (e.g., "Enacted", "Vetoed"). */
  lastAction: string | null;
  /** Date of the most recent action. */
  lastActionDate: string | null;
  description: string | null;
  tags: string[];
}

/** Column definition for the table. */
interface ColumnDef {
  key: string;
  label: string;
  sortKey: SortKey;
  defaultVisible: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: "billNumber", label: "Bill #", sortKey: "billNumber", defaultVisible: false },
  { key: "jurisdiction", label: "Jurisdiction", sortKey: "jurisdiction", defaultVisible: true },
  { key: "introduced", label: "Introduced", sortKey: "introduced", defaultVisible: true },
  { key: "status", label: "Status", sortKey: "status", defaultVisible: true },
  { key: "author", label: "Author", sortKey: "author", defaultVisible: false },
];

type SortKey =
  | "title"
  | "introduced"
  | "status"
  | "author"
  | "scope"
  | "jurisdiction"
  | "billNumber";

/** Get a display label for a jurisdiction, using scope as fallback. */
function jurisdictionLabel(row: LegislationRow): string | null {
  if (row.jurisdiction) return row.jurisdiction;
  if (row.scope) {
    const s = row.scope.toLowerCase();
    if (s === "federal") return "United States";
    return row.scope;
  }
  return null;
}

/** Scope ordering for grouped view. */
const SCOPE_ORDER: Record<string, number> = {
  international: 0,
  national: 1,
  federal: 2,
  state: 3,
};

export function LegislationTable({ rows }: { rows: LegislationRow[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [groupByJurisdiction, setGroupByJurisdiction] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)),
  );

  // Unique statuses
  const statuses = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of rows) {
      if (r.statusKey) {
        set.set(r.statusKey, (set.get(r.statusKey) ?? 0) + 1);
      }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Unique scopes
  const scopes = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of rows) {
      if (r.scope) {
        const key = r.scope.toLowerCase();
        set.set(key, (set.get(key) ?? 0) + 1);
      }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" || key === "author" ? "asc" : "desc");
    }
  };

  const toggleColumn = (key: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (statusFilter !== "all") {
      result = result.filter((r) => r.statusKey === statusFilter);
    }

    if (scopeFilter !== "all") {
      result = result.filter(
        (r) => r.scope?.toLowerCase() === scopeFilter,
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const searchable =
          `${r.title} ${r.author ?? ""} ${r.scope ?? ""} ${r.jurisdiction ?? ""} ${r.billNumber ?? ""} ${r.policyStatus ?? ""} ${r.description ?? ""} ${r.tags.join(" ")}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    const getValue = (row: LegislationRow): string | number | null => {
      switch (sortKey) {
        case "title":
          return row.title.toLowerCase();
        case "introduced":
          return row.introduced;
        case "status":
          return row.statusKey;
        case "author":
          return (row.author ?? "").toLowerCase();
        case "scope":
          return (row.scope ?? "").toLowerCase();
        case "jurisdiction":
          return (jurisdictionLabel(row) ?? "").toLowerCase();
        case "billNumber":
          return (row.billNumber ?? "").toLowerCase();
      }
    };
    result = [...result].sort((a, b) =>
      compareByValue(a, b, getValue, sortDir),
    );

    return result;
  }, [rows, search, statusFilter, scopeFilter, sortKey, sortDir]);

  /** Group rows by scope+jurisdiction, ordered by scope level then jurisdiction name. */
  const grouped = useMemo(() => {
    if (!groupByJurisdiction) return null;
    const groups = new Map<string, LegislationRow[]>();
    for (const row of filtered) {
      // Composite key prevents mixing e.g. "International" scope + "United States" jurisdiction
      // with "Federal" scope + "United States" jurisdiction
      const scope = row.scope?.toLowerCase() ?? "";
      const jur = jurisdictionLabel(row) ?? "Unknown";
      const key = `${scope}::${jur}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    // Sort groups: by scope order, then alphabetically by jurisdiction
    return [...groups.entries()].sort(([_aKey, aRows], [_bKey, bRows]) => {
      const aScope = SCOPE_ORDER[aRows[0].scope?.toLowerCase() ?? ""] ?? 99;
      const bScope = SCOPE_ORDER[bRows[0].scope?.toLowerCase() ?? ""] ?? 99;
      if (aScope !== bScope) return aScope - bScope;
      const aJur = jurisdictionLabel(aRows[0]) ?? "";
      const bJur = jurisdictionLabel(bRows[0]) ?? "";
      return aJur.localeCompare(bJur);
    });
  }, [filtered, groupByJurisdiction]);

  const activeColumns = COLUMNS.filter((c) => visibleColumns.has(c.key));

  /** Render a cell for the given column key. */
  function renderCell(col: ColumnDef, row: LegislationRow) {
    switch (col.key) {
      case "status":
        return row.statusKey ? (
          <div className="flex flex-col gap-0.5">
            <span
              className={`inline-flex items-center self-start px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap ${
                STATUS_COLORS[row.statusKey] ??
                "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {row.statusKey}
            </span>
            {row.lastActionDate && (
              <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap pl-0.5">
                {formatIntroducedDate(row.lastActionDate)}
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        );

      case "jurisdiction":
        return jurisdictionLabel(row) ? (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${
              SCOPE_COLORS[row.scope?.toLowerCase() ?? ""] ??
              "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            }`}
          >
            {jurisdictionLabel(row)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        );

      case "introduced":
        return (
          <span className="text-muted-foreground whitespace-nowrap">
            {formatIntroducedDate(row.introduced) ?? (
              <span className="text-muted-foreground/40">&mdash;</span>
            )}
          </span>
        );

      case "author":
        return (
          <span className="text-muted-foreground whitespace-nowrap">
            {row.author ?? <span className="text-muted-foreground/40">&mdash;</span>}
          </span>
        );

      case "billNumber":
        return row.billNumber ? (
          <Link
            href={`/legislation/${row.id}`}
            className="font-mono text-xs text-primary hover:underline whitespace-nowrap"
          >
            {row.billNumber}
          </Link>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        );

      default:
        return null;
    }
  }

  function renderRow(row: LegislationRow) {
    return (
      <tr key={row.id} className="hover:bg-muted/20 transition-colors">
        <td className="py-2.5 px-3 max-w-md">
          <Link
            href={`/legislation/${row.id}`}
            className="font-medium hover:text-primary transition-colors line-clamp-2"
          >
            {row.title}
          </Link>
          <div className="flex items-center gap-2 mt-0.5">
            {row.description && (
              <p className="text-xs text-muted-foreground/70 line-clamp-1 flex-1 min-w-0">
                {row.description}
              </p>
            )}
            <div className="flex items-center gap-1.5 shrink-0">
              {row.wikiId && (
                <Link
                  href={`/wiki/${row.wikiId}`}
                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground/60 hover:text-primary hover:border-primary/40 transition-colors"
                >
                  Wiki
                </Link>
              )}
              {row.fullTextUrl && (
                <a
                  href={row.fullTextUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground/60 hover:text-primary hover:border-primary/40 transition-colors"
                >
                  Bill ↗
                </a>
              )}
            </div>
          </div>
        </td>
        {activeColumns.map((col) => (
          <td key={col.key} className="py-2.5 px-3">
            {renderCell(col, row)}
          </td>
        ))}
      </tr>
    );
  }

  const pillBase = "text-xs px-3 py-1.5 rounded-lg border transition-all";
  const pillActive = "bg-primary/10 border-primary/30 text-primary font-semibold";
  const pillInactive = "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground";

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search legislation..."
            aria-label="Search legislation"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          {/* Status filter pills */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setStatusFilter("all")}
              className={`${pillBase} ${statusFilter === "all" ? pillActive : pillInactive}`}
            >
              All
              <span className="ml-1 text-[10px] opacity-60">{rows.length}</span>
            </button>
            {statuses.map(([status, count]) => (
              <button
                key={status}
                onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
                className={`${pillBase} capitalize ${statusFilter === status ? pillActive : pillInactive}`}
              >
                {status}
                <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Scope filter + View controls */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {scopes.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground/70 mr-0.5">Scope:</span>
              <button
                onClick={() => setScopeFilter("all")}
                className={`${pillBase} ${scopeFilter === "all" ? pillActive : pillInactive}`}
              >
                All
              </button>
              {scopes.map(([scope, count]) => (
                <button
                  key={scope}
                  onClick={() => setScopeFilter(scopeFilter === scope ? "all" : scope)}
                  className={`${pillBase} capitalize ${scopeFilter === scope ? pillActive : pillInactive}`}
                >
                  {scope}
                  <span className="ml-1 text-[10px] opacity-60">{count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 border-l border-border/40 pl-4">
            <span className="text-xs text-muted-foreground/70 mr-0.5">View:</span>
            <button
              onClick={() => setGroupByJurisdiction((g) => !g)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-all ${
                groupByJurisdiction
                  ? "bg-primary/10 border-primary/30 text-primary font-medium"
                  : "border-border/40 bg-card/50 text-muted-foreground/60 hover:text-muted-foreground hover:border-border/60"
              }`}
            >
              Group
            </button>
            {COLUMNS.filter((c) => !c.defaultVisible).map((col) => (
              <button
                key={col.key}
                onClick={() => toggleColumn(col.key)}
                className={`text-xs px-2.5 py-1 rounded-md border transition-all ${
                  visibleColumns.has(col.key)
                    ? "bg-primary/10 border-primary/30 text-primary font-medium"
                    : "border-border/40 bg-card/50 text-muted-foreground/60 hover:text-muted-foreground hover:border-border/60"
                }`}
              >
                + {col.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} policies
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader
                label="Legislation"
                sortKey="title"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              {activeColumns.map((col) => (
                <SortHeader
                  key={col.key}
                  label={col.label}
                  sortKey={col.sortKey}
                  currentSort={sortKey}
                  currentDir={sortDir}
                  onSort={handleSort}
                  className="text-left"
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grouped
              ? grouped.map(([compositeKey, groupRows]) => (
                  <GroupSection
                    key={compositeKey}
                    jurisdiction={jurisdictionLabel(groupRows[0]) ?? "Unknown"}
                    scope={groupRows[0].scope}
                    count={groupRows.length}
                    colSpan={1 + activeColumns.length}
                  >
                    {groupRows.map(renderRow)}
                  </GroupSection>
                ))
              : filtered.map(renderRow)}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No legislation matches your search.
        </div>
      )}
    </div>
  );
}

/** Jurisdiction group header row. */
function GroupSection({
  jurisdiction,
  scope,
  count,
  colSpan,
  children,
}: {
  jurisdiction: string;
  scope: string | null;
  count: number;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr className="bg-muted/40">
        <td colSpan={colSpan} className="py-2 px-3">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${
                SCOPE_COLORS[scope?.toLowerCase() ?? ""] ??
                "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {jurisdiction}
            </span>
            <span className="text-xs text-muted-foreground/60">
              {count} {count === 1 ? "policy" : "policies"}
            </span>
          </div>
        </td>
      </tr>
      {children}
    </>
  );
}
