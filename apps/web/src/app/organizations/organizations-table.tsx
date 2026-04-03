"use client";

import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { FilterChips } from "@/components/directory/FilterChips";
import { PaginationControls } from "@/components/directory/PaginationControls";
import { useDirectoryUrl } from "@/hooks/use-directory-url";
import type { SortDir } from "@/lib/sort-utils";
import { toggleSort } from "@/lib/sort-utils";
import { compareOrgRows } from "@/app/organizations/org-sort";
import type { OrgSortKey } from "@/app/organizations/org-sort";
import { ORG_TYPE_LABELS, ORG_TYPE_COLORS, DEFAULT_ORG_TYPE_COLOR, computeCompletionScore } from "@/app/organizations/org-constants";
import { useServerTable } from "@/hooks/use-server-table";

export interface OrgRow {
  id: string;
  slug: string | null;
  name: string;
  wikiId: string | null;
  orgType: string | null;
  wikiPageId: string | null;

  revenue: string | null;
  revenueNum: number | null;
  revenueDate: string | null;

  valuation: string | null;
  valuationNum: number | null;
  valuationDate: string | null;

  headcount: number | null;
  headcountDate: string | null;

  totalFunding: string | null;
  totalFundingNum: number | null;

  foundedDate: string | null;

  /** Number of tracked people (from employed-by facts). Null when unknown (API mode). */
  peopleCount: number | null;
  /** Completeness score 1-4 based on available data */
  completionScore: number;

  /** Pre-computed lowercase text blob for full-text search across all fields */
  searchText: string;
}

type SortKey = OrgSortKey;

function formatCompactNumber(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e10) return `$${(n / 1e9).toFixed(0)}B`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e7) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function formatHeadcount(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

function DateHint({ date }: { date: string | null }) {
  if (!date) return null;
  const parts = date.split("-");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthIdx = parts.length >= 2 ? parseInt(parts[1], 10) - 1 : NaN;
  const label = parts.length >= 2 && monthIdx >= 0 && monthIdx < 12
    ? `${MONTHS[monthIdx]} ${parts[0]}`
    : date;
  return (
    <span className="text-[10px] text-muted-foreground/50 ml-1">
      {label}
    </span>
  );
}

export type StatFilterKey = "all" | "withRevenue" | "withValuation" | "withHeadcount";

export interface OrgStatDef {
  key: StatFilterKey;
  label: string;
  value: string;
}

// ── Server response shape ──────────────────────────────────────────

interface ServerOrg {
  id: string;
  wikiId: string | null;
  stableId: string | null;
  title: string;
  description: string | null;
  website: string | null;
  revenueNum: number | null;
  revenueDate: string | null;
  valuationNum: number | null;
  valuationDate: string | null;
  headcount: number | null;
  headcountDate: string | null;
  totalFundingNum: number | null;
  foundedDate: string | null;
}

// Map OrgSortKey to server sort field names.
// orgType is not sortable server-side (not in DB).
const SORT_KEY_TO_SERVER_FIELD: Partial<Record<SortKey, string>> = {
  name: "name",
  revenue: "revenue",
  valuation: "valuation",
  headcount: "headcount",
  totalFunding: "totalFunding",
  founded: "founded",
};

const PAGE_SIZE = 50;

// Stable module-level transform function — avoids re-renders
function transformOrgsResponse(json: unknown): { rows: OrgRow[]; total: number } {
  const data = json as { organizations?: ServerOrg[]; total?: number };
  return {
    rows: (data.organizations ?? []).map((org) => ({
      id: org.id,
      slug: org.id,
      name: org.title,
      wikiId: org.wikiId,
      orgType: null, // Will be enriched client-side from orgTypeMap
      wikiPageId: org.wikiId,
      revenue: null,
      revenueNum: org.revenueNum,
      revenueDate: org.revenueDate,
      valuation: null,
      valuationNum: org.valuationNum,
      valuationDate: org.valuationDate,
      headcount: org.headcount,
      headcountDate: org.headcountDate,
      totalFunding: null,
      totalFundingNum: org.totalFundingNum,
      foundedDate: org.foundedDate,
      peopleCount: null, // Not available from API
      completionScore: computeCompletionScore(org),
      searchText: "",
    })),
    total: data.total ?? 0,
  };
}

// ── Component ───────────────────────────────────────────────────────

export function OrganizationsTable({
  rows,
  stats,
  serverEnabled = false,
  orgTypeMap,
}: {
  rows: OrgRow[];
  stats?: OrgStatDef[];
  /** When true, uses server-side search/sort/pagination via /api/organizations */
  serverEnabled?: boolean;
  /** Maps entity id -> orgType for enriching server results (orgType is not in the DB) */
  orgTypeMap?: Record<string, string>;
}) {
  const serverMode = serverEnabled;

  // ── Server-side state (hook always called for consistent hook order) ──
  const server = useServerTable<OrgRow>({
    endpoint: "/api/organizations",
    defaultPageSize: PAGE_SIZE,
    defaultSort: { field: "name", dir: "asc" },
    transform: transformOrgsResponse,
    enabled: serverMode,
  });

  // ── Local (static) state via URL-synced hook ──
  const url = useDirectoryUrl({
    defaultSort: { field: "name", dir: "asc" },
    filters: ["type", "stat"],
  });
  const {
    search: urlSearch, setSearch: urlSetSearch,
    sort: urlSort, setSort: urlSetSort,
    page: urlPage, setPage: urlSetPage,
    setFilter: urlSetFilter,
  } = url;
  const typeFilter = url.filters.type ?? "all";
  const statFilter = (url.filters.stat ?? "all") as StatFilterKey;

  // Collect unique org types for filter (always from static rows)
  const orgTypes = useMemo(() => {
    const types = new Set<string>();
    for (const r of rows) {
      if (r.orgType) types.add(r.orgType);
    }
    return [...types].sort();
  }, [rows]);

  // Count by type for badges (always from static rows)
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const t = r.orgType ?? "unknown";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  // ── Unified search handler ──
  const search = serverMode ? server.search : urlSearch;
  const { setSearch: serverSetSearch, setSort: serverSetSort, setPage: serverSetPage } = server;
  const handleSearch = useCallback((value: string) => {
    if (serverMode) {
      serverSetSearch(value);
    } else {
      urlSetSearch(value);
    }
  }, [serverMode, serverSetSearch, urlSetSearch]);

  // ── Unified sort ──
  const sortKey: SortKey = serverMode
    ? (server.sort.field as SortKey)
    : (urlSort.field as SortKey);
  const sortDir: SortDir = serverMode ? server.sort.dir : urlSort.dir;

  const handleSort = useCallback((key: SortKey) => {
    if (serverMode) {
      const serverField = SORT_KEY_TO_SERVER_FIELD[key];
      if (serverField) {
        // Read from server.sort (not urlSort) so toggling the same column correctly
        // flips direction. urlSort is never updated in server mode, so using it
        // always produces the same direction for repeated clicks on the same column.
        const currentServerSort = { field: server.sort.field as SortKey, dir: server.sort.dir };
        const { dir } = toggleSort(currentServerSort, key, ["name"]);
        serverSetSort(serverField, dir);
      }
    } else {
      urlSetSort(toggleSort(urlSort, key, ["name"]));
    }
  }, [serverMode, server.sort, serverSetSort, urlSetSort, urlSort]);

  // Build set of valid org IDs from static rows — used to filter out
  // server-returned entities that don't have a valid detail page (e.g.,
  // stale slugs like "center-for-ai-safety" or entities without org pages
  // like "google"). Without this filter, clicking them would 404.
  const validOrgIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  // ── Enrich server data with orgType from static map ──
  const enrichedServerData = useMemo(() => {
    if (!serverMode) return [];
    return server.data
      .filter((row) => validOrgIds.has(row.id))
      .map((row) => ({
        ...row,
        orgType: orgTypeMap?.[row.id] ?? null,
      }));
  }, [serverMode, server.data, orgTypeMap, validOrgIds]);

  // ── Client-side type/stat filtering (applied on both modes) ──
  const applyClientFilters = useCallback((data: OrgRow[]): OrgRow[] => {
    let result = data;

    if (typeFilter !== "all") {
      result = result.filter((r) => r.orgType === typeFilter);
    }

    if (statFilter !== "all") {
      switch (statFilter) {
        case "withRevenue":
          result = result.filter((r) => r.revenueNum != null);
          break;
        case "withValuation":
          result = result.filter((r) => r.valuationNum != null);
          break;
        case "withHeadcount":
          result = result.filter((r) => r.headcount != null);
          break;
      }
    }

    return result;
  }, [typeFilter, statFilter]);

  // ── Static mode: full client-side pipeline ──
  const localFiltered = useMemo(() => {
    if (serverMode) return [];
    let result = applyClientFilters(rows);

    if (urlSearch.trim()) {
      const q = urlSearch.toLowerCase();
      result = result.filter((r) => r.searchText.includes(q));
    }

    result = [...result].sort((a, b) =>
      compareOrgRows(a, b, urlSort.field as SortKey, urlSort.dir),
    );

    return result;
  }, [serverMode, rows, urlSearch, urlSort.field, urlSort.dir, applyClientFilters]);

  // ── Pagination ──
  const localTotalPages = Math.max(1, Math.ceil(localFiltered.length / PAGE_SIZE));
  const localSafePage = Math.min(urlPage, localTotalPages - 1);
  const localPageRows = serverMode
    ? []
    : localFiltered.slice(localSafePage * PAGE_SIZE, (localSafePage + 1) * PAGE_SIZE);

  // Server mode: apply client-side type/stat filters on top of server results
  const serverFiltered = useMemo(() => {
    if (!serverMode) return [];
    return applyClientFilters(enrichedServerData);
  }, [serverMode, enrichedServerData, applyClientFilters]);

  // ── Client-only filter fallback ──
  // When type/stat filters are active in server mode, the server doesn't know
  // about orgType (it's not in PG). Fall back to filtering static rows so
  // counts and pagination are accurate across all pages, not just the current one.
  const hasClientFilters = typeFilter !== "all" || statFilter !== "all";
  // Fall back to static rows when: client-side filters active, OR server errored out,
  // OR server returned no data after finishing load (empty result from unreachable API)
  const serverFailed = serverMode && !server.isLoading && server.error !== null;
  const useStaticFallback = serverMode && (hasClientFilters || serverFailed);

  const staticFiltered = useMemo(() => {
    if (!useStaticFallback) return [];
    let result = applyClientFilters(rows);
    if (urlSearch.trim()) {
      const q = urlSearch.toLowerCase();
      result = result.filter((r) => r.searchText.includes(q));
    }
    result = [...result].sort((a, b) =>
      compareOrgRows(a, b, urlSort.field as SortKey, urlSort.dir),
    );
    return result;
  }, [useStaticFallback, rows, applyClientFilters, urlSearch, urlSort.field, urlSort.dir]);

  const staticFilteredPages = Math.max(1, Math.ceil(staticFiltered.length / PAGE_SIZE));
  const staticSafePage = Math.min(urlPage, staticFilteredPages - 1);
  const staticPageRows = staticFiltered.slice(staticSafePage * PAGE_SIZE, (staticSafePage + 1) * PAGE_SIZE);

  // ── Unified display values ──
  const displayRows = useStaticFallback ? staticPageRows : serverMode ? serverFiltered : localPageRows;
  const currentPage = useStaticFallback ? staticSafePage : serverMode ? server.meta.page - 1 : localSafePage;
  const totalPages = useStaticFallback ? staticFilteredPages : serverMode ? server.meta.pageCount : localTotalPages;
  const displayTotal = useStaticFallback
    ? rows.length
    : serverMode
      ? server.meta.total
      : rows.length;
  const filteredTotal = useStaticFallback ? staticFiltered.length : serverMode ? serverFiltered.length : localFiltered.length;
  const hasFallbackRows = useStaticFallback && staticFiltered.length > 0;
  const isLoading = serverMode && !useStaticFallback ? server.isLoading : false;
  const isInitialLoad = serverMode && !useStaticFallback && server.isLoading && server.data.length === 0;

  const handlePageChange = useCallback((p: number) => {
    if (serverMode) {
      serverSetPage(p + 1); // hook uses 1-indexed pages
    } else {
      urlSetPage(p);
    }
  }, [serverMode, serverSetPage, urlSetPage]);

  /** Whether a column supports sorting in current mode */
  const isSortable = (key: SortKey) =>
    !serverMode || !!SORT_KEY_TO_SERVER_FIELD[key];

  // ── Status text ──
  const statusText = (() => {
    if (serverMode) {
      if (isLoading) return "Loading...";
      const fallbackNote = serverFailed && hasFallbackRows ? " (showing cached data)" : "";
      if (typeFilter !== "all" || statFilter !== "all") {
        return `${filteredTotal} of ${displayTotal} organizations (filtered)${fallbackNote}`;
      }
      return `${displayTotal} organizations${fallbackNote}`;
    }
    return `Showing ${filteredTotal} of ${rows.length} organizations`;
  })();

  // ── Column picker ──
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const colPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showColumnPicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) {
        setShowColumnPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showColumnPicker]);
  type OptionalColumnKey = "peopleCount" | "completionScore";
  const OPTIONAL_COLUMNS: { key: OptionalColumnKey; label: string }[] = [
    { key: "completionScore", label: "Data Completeness" },
    { key: "peopleCount", label: "People Tracked" },
  ];
  const [visibleColumns, setVisibleColumns] = useState<Set<OptionalColumnKey>>(
    () => new Set(["completionScore"]),
  );
  const toggleColumn = (key: OptionalColumnKey) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Base column count: Name + Type + Revenue + Valuation + Headcount + Funding + Founded = 7
  const activeColCount = 7 + (visibleColumns.has("completionScore") ? 1 : 0) + (visibleColumns.has("peopleCount") ? 1 : 0);

  return (
    <div>
      {/* Clickable stat cards */}
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {stats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              onClick={() => urlSetFilter("stat", statFilter === stat.key ? "all" : stat.key)}
              className={`rounded-xl border p-4 text-left transition-all ${
                statFilter === stat.key
                  ? "border-primary/50 bg-primary/5 ring-2 ring-primary/20 shadow-sm"
                  : "border-border/60 bg-gradient-to-br from-card to-muted/30 hover:border-primary/30 hover:shadow-md"
              }`}
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
                {stat.label}
              </div>
              <div className="text-xl font-bold tabular-nums tracking-tight">
                {stat.value}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div role="search" className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search name, type, people, funding programs, description..."
          aria-label="Search organizations"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-96"
        />
        <FilterChips
          items={orgTypes.map((t) => ({
            key: t,
            label: ORG_TYPE_LABELS[t] ?? t,
            count: typeCounts[t] ?? 0,
          }))}
          selected={typeFilter}
          onSelect={(key) => urlSetFilter("type", key)}
          allCount={typeCounts.all}
        />
      </div>

      {/* Results count + column picker */}
      <div className="flex items-center gap-3 mb-3">
        <span className={`text-xs ${serverFailed ? "text-destructive" : "text-muted-foreground"}`}>
          {statusText}
        </span>
        <div className="ml-auto relative" ref={colPickerRef}>
          <button
            type="button"
            onClick={() => setShowColumnPicker((v) => !v)}
            className="px-3 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted/50 transition-colors text-muted-foreground"
          >
            Columns ({visibleColumns.size})
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 min-w-[180px]">
              {OPTIONAL_COLUMNS.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted/50 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(col.key)}
                    onChange={() => toggleColumn(col.key)}
                    className="rounded"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Organizations directory with financial and headcount data</caption>
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Organization" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              {isSortable("orgType") ? (
                <SortHeader label="Type" sortKey="orgType" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              ) : (
                <th scope="col" className="py-2.5 px-3 font-medium text-left">Type</th>
              )}
              {visibleColumns.has("completionScore") && (
                isSortable("completionScore") ? (
                  <SortHeader label="Data" sortKey="completionScore" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
                ) : (
                  <th scope="col" className="py-2.5 px-3 font-medium text-center">Data</th>
                )
              )}
              <SortHeader label="Revenue" sortKey="revenue" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Valuation" sortKey="valuation" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Headcount" sortKey="headcount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Total Funding" sortKey="totalFunding" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Founded" sortKey="founded" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              {visibleColumns.has("peopleCount") && (
                isSortable("peopleCount") ? (
                  <SortHeader label="People" sortKey="peopleCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
                ) : (
                  <th scope="col" className="py-2.5 px-3 font-medium text-right">People</th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {isInitialLoad ? (
              <tr>
                <td
                  colSpan={activeColCount}
                  role="status"
                  aria-live="polite"
                  className="py-8 text-center text-muted-foreground text-sm"
                >
                  Loading organizations...
                </td>
              </tr>
            ) : (
              <>
                {displayRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`hover:bg-muted/20 transition-colors ${isLoading ? "opacity-50" : ""}`}
                  >
                    {/* Name */}
                    <td className="py-2.5 px-3">
                      {row.slug ? (
                        <Link
                          href={`/organizations/${row.slug}`}
                          className="font-medium text-foreground hover:text-primary transition-colors"
                        >
                          {row.name}
                        </Link>
                      ) : (
                        <span className="font-medium text-foreground">{row.name}</span>
                      )}
                      {row.wikiPageId && (
                        <Link
                          href={`/wiki/${row.wikiPageId}`}
                          className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                          title="Wiki page"
                        >
                          wiki
                        </Link>
                      )}
                    </td>

                    {/* Type */}
                    <td className="py-2.5 px-3">
                      {row.orgType && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            ORG_TYPE_COLORS[row.orgType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                          }`}
                        >
                          {ORG_TYPE_LABELS[row.orgType] ?? row.orgType}
                        </span>
                      )}
                    </td>

                    {/* Completion Score */}
                    {visibleColumns.has("completionScore") && (
                      <td className="py-2.5 px-3 text-center">
                        <CompletionDots score={row.completionScore} ariaLabel={`Completeness: ${row.completionScore}/4`} />
                      </td>
                    )}

                    {/* Revenue */}
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                      {row.revenueNum != null ? (
                        <>
                          <span className="font-semibold">{formatCompactNumber(row.revenueNum)}</span>
                          <DateHint date={row.revenueDate} />
                        </>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>

                    {/* Valuation */}
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                      {row.valuationNum != null ? (
                        <>
                          <span className="font-semibold">{formatCompactNumber(row.valuationNum)}</span>
                          <DateHint date={row.valuationDate} />
                        </>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>

                    {/* Headcount */}
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                      {row.headcount != null ? (
                        <>
                          <span>{formatHeadcount(row.headcount)}</span>
                          <DateHint date={row.headcountDate} />
                        </>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>

                    {/* Total Funding */}
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                      {row.totalFundingNum != null ? (
                        <span className="font-semibold">{formatCompactNumber(row.totalFundingNum)}</span>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>

                    {/* Founded */}
                    <td className="py-2.5 px-3 text-center text-muted-foreground">
                      {row.foundedDate ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>

                    {/* People Count */}
                    {visibleColumns.has("peopleCount") && (
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {row.peopleCount != null && row.peopleCount > 0 ? (
                          <span>{row.peopleCount}</span>
                        ) : (
                          <span className="text-muted-foreground/40">{"\u2014"}</span>
                        )}
                      </td>
                    )}

                  </tr>
                ))}
                {displayRows.length === 0 && !isInitialLoad && (
                  <tr>
                    <td
                      colSpan={activeColCount}
                      className="py-8 text-center text-muted-foreground text-sm"
                    >
                      {search
                        ? "No organizations match your search."
                        : "No organizations found."}
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
        <div className="mt-3">
          <PaginationControls
          page={currentPage}
          pageCount={totalPages}
          totalItems={filteredTotal}
          pageSize={PAGE_SIZE}
          onPageChange={handlePageChange}
        />
        </div>
      )}
    </div>
  );
}

/** Renders 1-4 filled/empty dots for data completeness. */
function CompletionDots({ score, ariaLabel }: { score: number; ariaLabel: string }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={ariaLabel}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            i <= score
              ? "bg-primary/70"
              : "bg-muted-foreground/20"
          }`}
        />
      ))}
    </span>
  );
}
