"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { formatCompactCurrency } from "@/lib/format-compact";
import { topicLabel } from "@/data/topic-labels";

export interface PersonRow {
  id: string;
  slug: string;
  name: string;
  numericId: string | null;
  wikiPageId: string | null;

  role: string | null;

  employerId: string | null;
  employerName: string | null;

  bornYear: number | null;

  netWorthNum: number | null;

  positionCount: number;
  topics: string[];

  publicationCount: number;
  careerHistoryCount: number;
}

type SortKey =
  | "name"
  | "role"
  | "employer"
  | "bornYear"
  | "netWorth"
  | "positions"
  | "publications"
  | "careerHistory";

type SortDir = "asc" | "desc";

export function PeopleTable({ rows }: { rows: PersonRow[] }) {
  const [search, setSearch] = useState("");
  const [affiliationFilter, setAffiliationFilter] = useState<string>("all");
  const [topicFilter, setTopicFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Collect top affiliations for filter (only those with 2+ people)
  const affiliations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.employerName) {
        counts.set(r.employerName, (counts.get(r.employerName) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [rows]);

  // Collect all topics with person counts, sorted by count descending
  const topicOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.topics) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "role" || key === "employer" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (affiliationFilter !== "all") {
      result = result.filter((r) => r.employerName === affiliationFilter);
    }

    if (topicFilter !== "all") {
      result = result.filter((r) => r.topics.includes(topicFilter));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.role && r.role.toLowerCase().includes(q)) ||
          (r.employerName && r.employerName.toLowerCase().includes(q)),
      );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      const getValue = (row: PersonRow): string | number | null => {
        switch (sortKey) {
          case "name":
            return row.name.toLowerCase();
          case "role":
            return row.role?.toLowerCase() ?? null;
          case "employer":
            return row.employerName?.toLowerCase() ?? null;
          case "bornYear":
            return row.bornYear;
          case "netWorth":
            return row.netWorthNum;
          case "positions":
            return row.positionCount || null;
          case "publications":
            return row.publicationCount || null;
          case "careerHistory":
            return row.careerHistoryCount;
        }
      };

      const va = getValue(a);
      const vb = getValue(b);

      // Nulls sort last regardless of direction
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });

    return result;
  }, [rows, search, affiliationFilter, topicFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search people..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          {affiliations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setAffiliationFilter("all")}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  affiliationFilter === "all"
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                All
                <span className="ml-1 text-[10px] opacity-60">{rows.length}</span>
              </button>
              {affiliations.map(([name, count]) => (
                <button
                  key={name}
                  onClick={() => setAffiliationFilter(affiliationFilter === name ? "all" : name)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                    affiliationFilter === name
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

        {/* Topic filter */}
        {topicOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground font-medium mr-1">Topics:</span>
            <button
              onClick={() => setTopicFilter("all")}
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
                onClick={() => setTopicFilter(topicFilter === slug ? "all" : slug)}
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
      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} people
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Name" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Role" sortKey="role" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Affiliation" sortKey="employer" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Born" sortKey="bornYear" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="Net Worth" sortKey="netWorth" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Positions" sortKey="positions" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="Pubs" sortKey="publications" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="Career Entries" sortKey="careerHistory" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
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
                      className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>

                {/* Role */}
                <td className="py-2.5 px-3 text-muted-foreground">
                  {row.role ?? ""}
                </td>

                {/* Affiliation */}
                <td className="py-2.5 px-3">
                  {row.employerId ? (
                    <Link
                      href={`/kb/entity/${row.employerId}`}
                      className="text-foreground hover:text-primary transition-colors"
                    >
                      {row.employerName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{row.employerName ?? ""}</span>
                  )}
                </td>

                {/* Born Year */}
                <td className="py-2.5 px-3 text-center text-muted-foreground tabular-nums">
                  {row.bornYear ?? ""}
                </td>

                {/* Net Worth */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.netWorthNum != null && (
                    <span className="font-semibold">{formatCompactCurrency(row.netWorthNum)}</span>
                  )}
                </td>

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
                    <span className="tabular-nums">{row.careerHistoryCount}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No people match your search.
        </div>
      )}
    </div>
  );
}
