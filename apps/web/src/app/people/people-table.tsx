"use client";

import { useMemo, useCallback } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { FilterChips } from "@/components/directory/FilterChips";
import { PaginationControls } from "@/components/directory/PaginationControls";
import { useDirectoryUrl } from "@/hooks/use-directory-url";
import { formatCompactCurrency } from "@/lib/format-compact";
import type { SortDir } from "@/lib/sort-utils";
import { toggleSort } from "@/lib/sort-utils";
import { topicLabel } from "@/data/topic-labels";
import { useServerTable } from "@/hooks/use-server-table";
import { comparePersonRows } from "./people-sort";
import type { PeopleSortKey } from "./people-sort";

export interface PersonRow {
  id: string;
  slug: string;
  name: string;
  numericId: string | null;
  wikiPageId: string | null;

  role: string | null;

  employerId: string | null;
  employerName: string | null;
  employerSlug: string | null;

  bornYear: number | null;

  netWorthNum: number | null;

  positionCount: number;
  topics: string[];

  publicationCount: number;
  careerHistoryCount: number;

  /** Pre-computed lowercase text blob for full-text search across all fields */
  searchText: string;
}

// ── Server person shape (from wiki-server API) ──────────────────────

interface ServerPerson {
  id: string;
  slug: string;
  name: string;
  numericId: string | null;
  description: string | null;
  role: string | null;
  employerId: string | null;
  employerName: string | null;
  bornYear: number | null;
  netWorth: number | null;
}

function serverPersonToRow(p: ServerPerson): PersonRow {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    numericId: p.numericId,
    wikiPageId: p.numericId ?? null,
    role: p.role,
    employerId: p.employerId,
    employerName: p.employerName,
    employerSlug: null, // Not available from server — employer links use employerId
    bornYear: p.bornYear,
    netWorthNum: p.netWorth,
    positionCount: 0, // Not available from server
    topics: [],
    publicationCount: 0,
    careerHistoryCount: 0,
    searchText: "", // Not needed in server mode
  };
}

// Module-level transform — stable reference, no re-renders
function transformPeopleResponse(json: unknown): {
  rows: PersonRow[];
  total: number;
} {
  const data = json as { items?: ServerPerson[]; total?: number };
  return {
    rows: (data.items ?? []).map(serverPersonToRow),
    total: data.total ?? 0,
  };
}

// Stable empty array constant
const EMPTY_ROWS: PersonRow[] = [];

const PAGE_SIZE = 50;

// Map PeopleSortKey to server sort field names (subset that server supports)
const SORT_KEY_TO_SERVER_FIELD: Partial<Record<PeopleSortKey, string>> = {
  name: "name",
  role: "role",
  employer: "employer",
  bornYear: "bornYear",
  netWorth: "netWorth",
};

type SortKey = PeopleSortKey;

export function PeopleTable({
  rows: staticRows,
  serverMode = false,
}: {
  rows?: PersonRow[];
  /** When true, uses server-side search/sort/pagination via /api/people */
  serverMode?: boolean;
}) {
  // ── Server-side state (hook always called for consistent hook order) ──
  const server = useServerTable<PersonRow>({
    endpoint: "/api/people",
    defaultPageSize: PAGE_SIZE,
    defaultSort: { field: "name", dir: "asc" },
    transform: transformPeopleResponse,
    enabled: serverMode,
  });

  // ── Local (static) state via URL-synced hook ──
  const url = useDirectoryUrl({
    defaultSort: { field: "name", dir: "asc" },
    filters: ["affiliation", "topic"],
  });
  const {
    search: urlSearch, setSearch: urlSetSearch,
    sort: urlSort, setSort: urlSetSort,
    page: urlPage, setPage: urlSetPage,
    setFilter: urlSetFilter,
  } = url;
  const affiliationFilter = url.filters.affiliation ?? "all";
  const topicFilter = url.filters.topic ?? "all";

  const allRows = staticRows ?? EMPTY_ROWS;

  // Collect top affiliations for filter (only those with 2+ people)
  // In server mode, affiliations will be empty (server filter uses text).
  const affiliationChips = useMemo(() => {
    const dataSource = serverMode ? EMPTY_ROWS : allRows;
    const counts = new Map<string, number>();
    for (const r of dataSource) {
      if (r.employerName) {
        counts.set(r.employerName, (counts.get(r.employerName) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ key: name, label: name, count }));
  }, [allRows, serverMode]);

  // Collect all topics (static mode only — topics not available from server)
  const topicChips = useMemo(() => {
    if (serverMode) return [];
    const counts = new Map<string, number>();
    for (const r of allRows) {
      for (const t of r.topics) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, count]) => ({ key: slug, label: topicLabel(slug), count }));
  }, [allRows, serverMode]);

  // ── Unified search handler ──
  const search = serverMode ? server.search : urlSearch;
  const {
    setSearch: serverSetSearch,
    setSort: serverSetSort,
    setPage: serverSetPage,
  } = server;

  const handleSearch = useCallback(
    (value: string) => {
      if (serverMode) {
        serverSetSearch(value);
      } else {
        urlSetSearch(value);
      }
    },
    [serverMode, serverSetSearch, urlSetSearch],
  );

  // ── Unified sort ──
  const sortKey: SortKey = serverMode
    ? (server.sort.field as SortKey)
    : (urlSort.field as SortKey);
  const sortDir: SortDir = serverMode ? server.sort.dir : urlSort.dir;

  const handleSort = useCallback(
    (key: SortKey) => {
      if (serverMode) {
        const serverField = SORT_KEY_TO_SERVER_FIELD[key];
        if (serverField) {
          const { dir } = toggleSort(urlSort, key, ["name", "role", "employer"]);
          serverSetSort(serverField, dir);
        }
      } else {
        urlSetSort(toggleSort(urlSort, key, ["name", "role", "employer"]));
      }
    },
    [serverMode, serverSetSort, urlSetSort, urlSort],
  );

  const { filters: serverFilters, setFilter: serverSetFilter } = server;
  const handleAffiliationFilter = useCallback(
    (key: string) => {
      if (serverMode) {
        const newValue =
          serverFilters["affiliation"] === key ? undefined : key;
        serverSetFilter("affiliation", newValue);
      } else {
        urlSetFilter("affiliation", key);
      }
    },
    [serverMode, serverFilters, serverSetFilter, urlSetFilter],
  );

  const handlePageChange = useCallback(
    (p: number) => {
      if (serverMode) {
        serverSetPage(p + 1); // hook uses 1-indexed pages
      } else {
        urlSetPage(p);
      }
    },
    [serverMode, serverSetPage, urlSetPage],
  );

  // ── Static-mode: filter, sort, paginate ──

  const localFiltered = useMemo(() => {
    if (serverMode) return EMPTY_ROWS;
    let result = allRows;

    if (affiliationFilter !== "all") {
      result = result.filter((r) => r.employerName === affiliationFilter);
    }

    if (topicFilter !== "all") {
      result = result.filter((r) => r.topics.includes(topicFilter));
    }

    if (urlSearch.trim()) {
      const q = urlSearch.toLowerCase();
      result = result.filter((r) => r.searchText.includes(q));
    }

    result = [...result].sort((a, b) =>
      comparePersonRows(
        a,
        b,
        urlSort.field as SortKey,
        urlSort.dir,
      ),
    );

    return result;
  }, [serverMode, allRows, affiliationFilter, topicFilter, urlSearch, urlSort.field, urlSort.dir]);

  const localTotalPages = Math.max(
    1,
    Math.ceil(localFiltered.length / PAGE_SIZE),
  );
  const localSafePage = Math.min(urlPage, localTotalPages - 1);
  const localPageRows = serverMode
    ? EMPTY_ROWS
    : localFiltered.slice(
        localSafePage * PAGE_SIZE,
        (localSafePage + 1) * PAGE_SIZE,
      );

  // ── Unified interface ──
  const rows = serverMode ? server.data : localPageRows;
  const currentPage = serverMode ? server.meta.page - 1 : localSafePage;
  const totalPages = serverMode ? server.meta.pageCount : localTotalPages;
  const displayTotal = serverMode ? server.meta.total : allRows.length;
  const filteredTotal = serverMode ? server.meta.total : localFiltered.length;
  const isLoading = serverMode ? server.isLoading : false;
  const isInitialLoad =
    serverMode && server.isLoading && server.data.length === 0;
  const activeAffiliation = serverMode
    ? serverFilters["affiliation"] ?? "all"
    : affiliationFilter;

  // ── Status text ──
  const statusText = (() => {
    if (serverMode) {
      if (isLoading) return "Loading...";
      return `${displayTotal} people`;
    }
    const filterCount =
      filteredTotal === allRows.length
        ? `${allRows.length} people`
        : `${filteredTotal} of ${allRows.length} people`;
    return `Showing ${filterCount}`;
  })();

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search name, role, affiliation, publications, positions..."
            aria-label="Search people"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-96"
          />
          {search && (
            <button
              type="button"
              onClick={() => handleSearch("")}
              className="text-xs text-muted-foreground hover:text-foreground px-2"
            >
              Clear
            </button>
          )}
          {!serverMode && affiliationChips.length > 0 && (
            <FilterChips
              items={affiliationChips}
              selected={activeAffiliation}
              onSelect={handleAffiliationFilter}
              allCount={allRows.length}
            />
          )}
        </div>

        {/* Topic filter (static mode only) */}
        {!serverMode && topicChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground font-medium mr-1">
              Topics:
            </span>
            <FilterChips
              items={topicChips}
              selected={topicFilter}
              onSelect={(key) => urlSetFilter("topic", key)}
              allLabel="All Topics"
            />
          </div>
        )}
      </div>

      {/* Results count */}
      <div className="text-xs text-muted-foreground mb-3">{statusText}</div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader
                label="Name"
                sortKey="name"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Role"
                sortKey="role"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Affiliation"
                sortKey="employer"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Born"
                sortKey="bornYear"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-center"
              />
              <SortHeader
                label="Net Worth"
                sortKey="netWorth"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              {!serverMode && (
                <>
                  <SortHeader
                    label="Positions"
                    sortKey="positions"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-center"
                  />
                  <SortHeader
                    label="Pubs"
                    sortKey="publications"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-center"
                  />
                  <SortHeader
                    label="Career Entries"
                    sortKey="careerHistory"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-center"
                  />
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {isInitialLoad ? (
              <tr>
                <td
                  colSpan={serverMode ? 5 : 8}
                  className="py-8 text-center text-muted-foreground text-sm"
                >
                  Loading people...
                </td>
              </tr>
            ) : (
              <>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`hover:bg-muted/20 transition-colors ${isLoading ? "opacity-50" : ""}`}
                  >
                    {/* Name */}
                    <td className="py-2.5 px-3">
                      <Link
                        href={`/people/${row.slug}`}
                        className="font-medium text-foreground hover:text-primary transition-colors"
                      >
                        {row.name}
                      </Link>
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

                    {/* Role */}
                    <td className="py-2.5 px-3 text-muted-foreground">
                      {row.role ?? (
                        <span className="text-muted-foreground/40">
                          &mdash;
                        </span>
                      )}
                    </td>

                    {/* Affiliation */}
                    <td className="py-2.5 px-3">
                      {row.employerSlug ? (
                        <Link
                          href={`/organizations/${row.employerSlug}`}
                          className="text-foreground hover:text-primary transition-colors"
                        >
                          {row.employerName}
                        </Link>
                      ) : row.employerId ? (
                        <Link
                          href={`/kb/entity/${row.employerId}`}
                          className="text-foreground hover:text-primary transition-colors"
                        >
                          {row.employerName}
                        </Link>
                      ) : row.employerName ? (
                        <span className="text-muted-foreground">
                          {row.employerName}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">
                          &mdash;
                        </span>
                      )}
                    </td>

                    {/* Born Year */}
                    <td className="py-2.5 px-3 text-center text-muted-foreground tabular-nums">
                      {row.bornYear ?? (
                        <span className="text-muted-foreground/40">
                          &mdash;
                        </span>
                      )}
                    </td>

                    {/* Net Worth */}
                    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                      {row.netWorthNum != null ? (
                        <span className="font-semibold">
                          {formatCompactCurrency(row.netWorthNum)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">
                          &mdash;
                        </span>
                      )}
                    </td>

                    {/* Static-mode-only columns */}
                    {!serverMode && (
                      <>
                        {/* Positions */}
                        <td className="py-2.5 px-3 text-center tabular-nums">
                          {row.positionCount > 0 && (
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                              {row.positionCount}
                            </span>
                          )}
                        </td>

                        {/* Publications */}
                        <td className="py-2.5 px-3 text-center tabular-nums">
                          {row.publicationCount > 0 && (
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
                              {row.publicationCount}
                            </span>
                          )}
                        </td>

                        {/* Career History */}
                        <td className="py-2.5 px-3 text-center">
                          {row.careerHistoryCount > 0 && (
                            <span className="tabular-nums">
                              {row.careerHistoryCount}
                            </span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && !isInitialLoad && (
                  <tr>
                    <td
                      colSpan={serverMode ? 5 : 8}
                      className="py-8 text-center text-muted-foreground text-sm"
                    >
                      {search
                        ? "No people match your search."
                        : "No people found."}
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
