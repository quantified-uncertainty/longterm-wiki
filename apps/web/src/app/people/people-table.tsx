"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { formatCompactCurrency } from "@/lib/format-compact";
import { topicLabel } from "@/data/topic-labels";
import { useServerTable } from "@/hooks/use-server-table";
import { comparePersonRows } from "./people-sort";
import type { PeopleSortKey, SortDir } from "./people-sort";

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

  // ── Static-mode state ──
  const [localSearch, setLocalSearch] = useState("");
  const [affiliationFilter, setAffiliationFilter] = useState<string>("all");
  const [topicFilter, setTopicFilter] = useState<string>("all");
  const [localSortKey, setLocalSortKey] = useState<SortKey>("name");
  const [localSortDir, setLocalSortDir] = useState<SortDir>("asc");
  const [localPage, setLocalPage] = useState(0);

  const allRows = staticRows ?? EMPTY_ROWS;

  // Collect top affiliations for filter (only those with 2+ people)
  // In server mode, we still compute from static rows if available for the filter chips.
  // If server mode and no static rows, affiliations will be empty (server filter uses text).
  const affiliations = useMemo(() => {
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
      .slice(0, 10);
  }, [allRows, serverMode]);

  // Collect all topics (static mode only — topics not available from server)
  const topicOptions = useMemo(() => {
    if (serverMode) return [];
    const counts = new Map<string, number>();
    for (const r of allRows) {
      for (const t of r.topics) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allRows, serverMode]);

  // ── Event handlers ──

  const handleSearch = (value: string) => {
    if (serverMode) {
      server.setSearch(value);
    } else {
      setLocalSearch(value);
      setLocalPage(0);
    }
  };

  const handleSort = (key: SortKey) => {
    if (serverMode) {
      const serverField = SORT_KEY_TO_SERVER_FIELD[key];
      if (serverField) {
        server.setSort(serverField);
      }
    } else {
      if (localSortKey === key) {
        setLocalSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setLocalSortKey(key);
        setLocalSortDir(
          key === "name" || key === "role" || key === "employer"
            ? "asc"
            : "desc",
        );
      }
      setLocalPage(0);
    }
  };

  const handleAffiliationFilter = (name: string) => {
    if (serverMode) {
      const newValue =
        server.filters["affiliation"] === name ? undefined : name;
      server.setFilter("affiliation", newValue);
    } else {
      setAffiliationFilter(affiliationFilter === name ? "all" : name);
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

    if (localSearch.trim()) {
      const q = localSearch.toLowerCase();
      result = result.filter((r) => r.searchText.includes(q));
    }

    result = [...result].sort((a, b) =>
      comparePersonRows(a, b, localSortKey, localSortDir),
    );

    return result;
  }, [
    serverMode,
    allRows,
    affiliationFilter,
    topicFilter,
    localSearch,
    localSortKey,
    localSortDir,
  ]);

  const localTotalPages = Math.max(
    1,
    Math.ceil(localFiltered.length / PAGE_SIZE),
  );
  const localSafePage = Math.min(localPage, localTotalPages - 1);
  const localPageRows = serverMode
    ? EMPTY_ROWS
    : localFiltered.slice(
        localSafePage * PAGE_SIZE,
        (localSafePage + 1) * PAGE_SIZE,
      );

  // ── Unified interface ──
  const rows = serverMode ? server.data : localPageRows;
  const search = serverMode ? server.search : localSearch;
  const sortKey: SortKey = serverMode
    ? (server.sort.field as SortKey)
    : localSortKey;
  const sortDir: SortDir = serverMode ? server.sort.dir : localSortDir;
  const currentPage = serverMode ? server.meta.page - 1 : localSafePage;
  const totalPages = serverMode ? server.meta.pageCount : localTotalPages;
  const displayTotal = serverMode ? server.meta.total : allRows.length;
  const filteredTotal = serverMode ? server.meta.total : localFiltered.length;
  const isLoading = serverMode ? server.isLoading : false;
  const isInitialLoad =
    serverMode && server.isLoading && server.data.length === 0;
  const activeAffiliation = serverMode
    ? server.filters["affiliation"] ?? "all"
    : affiliationFilter;

  // ── Status text ──
  const statusText = (() => {
    if (serverMode) {
      if (isLoading) return "Loading...";
      return `${displayTotal} people`;
    }
    const filterCount = filteredTotal === allRows.length
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
          {!serverMode && affiliations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => {
                  setAffiliationFilter("all");
                  setLocalPage(0);
                }}
                aria-pressed={affiliationFilter === "all"}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  activeAffiliation === "all"
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                All
                <span className="ml-1 text-[10px] opacity-60">
                  {allRows.length}
                </span>
              </button>
              {affiliations.map(([name, count]) => (
                <button
                  key={name}
                  onClick={() => handleAffiliationFilter(name)}
                  aria-pressed={affiliationFilter === name}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                    activeAffiliation === name
                      ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                      : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                  }`}
                >
                  {name}
                  <span className="ml-1 text-[10px] opacity-60">{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Topic filter (static mode only) */}
        {!serverMode && topicOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground font-medium mr-1">
              Topics:
            </span>
            <button
              onClick={() => {
                setTopicFilter("all");
                setLocalPage(0);
              }}
              aria-pressed={topicFilter === "all"}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                topicFilter === "all"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All Topics
            </button>
            {topicOptions.map(([slug, count]) => (
              <button
                key={slug}
                onClick={() => {
                  setTopicFilter(topicFilter === slug ? "all" : slug);
                  setLocalPage(0);
                }}
                aria-pressed={topicFilter === slug}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  topicFilter === slug
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {topicLabel(slug)}
                <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
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
        <div className="flex items-center justify-between text-xs text-muted-foreground mt-3">
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
