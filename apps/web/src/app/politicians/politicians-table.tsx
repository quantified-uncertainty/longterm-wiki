"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import {
  AI_STANCE_COLORS,
  PARTY_COLORS,
  EA_TOPICS,
  extractStanceLabel,
} from "./politicians-constants";

export interface PoliticianRow {
  id: string;
  title: string;
  wikiId: string | null;
  description: string | null;
  office: string | null;
  party: string | null;
  jurisdiction: string | null;
  status: string | null;
  website: string | null;
  /** Map of EA topic → stance view string */
  stances: Record<string, string>;
  /** Number of external source links */
  sourceCount: number;
  tags: string[];
}

type SortKey = "title" | "office" | "party" | "jurisdiction" | "sourceCount";

export function PoliticiansTable({ rows }: { rows: PoliticianRow[] }) {
  const [search, setSearch] = useState("");
  const [partyFilter, setPartyFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const parties = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.party) map.set(r.party, (map.get(r.party) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const statuses = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.status) map.set(r.status, (map.get(r.status) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (partyFilter !== "all") {
      result = result.filter((r) => r.party === partyFilter);
    }
    if (statusFilter !== "all") {
      result = result.filter((r) => r.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const searchable = `${r.title} ${r.office ?? ""} ${r.party ?? ""} ${r.jurisdiction ?? ""} ${r.description ?? ""} ${Object.values(r.stances).join(" ")} ${r.tags.join(" ")}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    const getValue = (row: PoliticianRow): string | number | null => {
      switch (sortKey) {
        case "title": return row.title.toLowerCase();
        case "office": return (row.office ?? "").toLowerCase();
        case "party": return (row.party ?? "").toLowerCase();
        case "jurisdiction": return (row.jurisdiction ?? "").toLowerCase();
        case "sourceCount": return row.sourceCount;
      }
    };
    return [...result].sort((a, b) => compareByValue(a, b, getValue, sortDir));
  }, [rows, search, partyFilter, statusFilter, sortKey, sortDir]);

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
            placeholder="Search politicians..."
            aria-label="Search politicians"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          {/* Party filter */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setPartyFilter("all")}
              aria-pressed={partyFilter === "all"}
              className={`${pillBase} ${partyFilter === "all" ? pillActive : pillInactive}`}
            >
              All <span className="ml-1 text-[10px] opacity-60">{rows.length}</span>
            </button>
            {parties.map(([party, count]) => (
              <button
                key={party}
                onClick={() => setPartyFilter(partyFilter === party ? "all" : party)}
                aria-pressed={partyFilter === party}
                className={`${pillBase} capitalize ${partyFilter === party ? pillActive : pillInactive}`}
              >
                {party} <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Status filter */}
        {statuses.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground/70 mr-0.5">Status:</span>
            <button
              onClick={() => setStatusFilter("all")}
              aria-pressed={statusFilter === "all"}
              className={`${pillBase} ${statusFilter === "all" ? pillActive : pillInactive}`}
            >
              All
            </button>
            {statuses.map(([status, count]) => (
              <button
                key={status}
                onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
                aria-pressed={statusFilter === status}
                className={`${pillBase} capitalize ${statusFilter === status ? pillActive : pillInactive}`}
              >
                {status} <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} politicians
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Name" sortKey="title" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Office" sortKey="office" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Party" sortKey="party" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              {EA_TOPICS.map((topic) => (
                <th key={topic} className="py-2.5 px-3 text-left font-medium whitespace-nowrap">
                  {topic.replace("AI safety and regulation", "AI Safety").replace("Science and technology funding", "Sci/Tech").replace("Nuclear energy", "Nuclear").replace("Animal welfare", "Animals")}
                </th>
              ))}
              <SortHeader label="Sources" sortKey="sourceCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                {/* Name */}
                <td className="py-2.5 px-3 max-w-xs">
                  <div className="flex flex-col">
                    <Link
                      href={`/people/${row.id}`}
                      className="font-medium hover:text-primary transition-colors line-clamp-1"
                    >
                      {row.title}
                    </Link>
                    {row.jurisdiction && (
                      <span className="text-[10px] text-muted-foreground/60 leading-tight">
                        {row.jurisdiction}
                      </span>
                    )}
                  </div>
                </td>

                {/* Office */}
                <td className="py-2.5 px-3 whitespace-nowrap">
                  {row.office ? (
                    <span className="text-muted-foreground text-xs">{row.office}</span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Party */}
                <td className="py-2.5 px-3">
                  {row.party ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap ${PARTY_COLORS[row.party] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
                      {row.party === "democratic" ? "D" : row.party === "republican" ? "R" : row.party.charAt(0).toUpperCase()}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* EA topic stances */}
                {EA_TOPICS.map((topic) => {
                  const view = row.stances[topic];
                  const label = extractStanceLabel(view);
                  return (
                    <td key={topic} className="py-2.5 px-2">
                      {view ? (
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize whitespace-nowrap ${AI_STANCE_COLORS[label] ?? AI_STANCE_COLORS.unknown}`}
                          title={view}
                        >
                          {label === "strongly supportive" ? "Strong" :
                           label === "mildly supportive" ? "Mild" :
                           label === "strongly opposed" ? "Strong-" :
                           label.charAt(0).toUpperCase() + label.slice(1)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/30 text-[10px]">&mdash;</span>
                      )}
                    </td>
                  );
                })}

                {/* Source count */}
                <td className="py-2.5 px-3 text-center">
                  <span className="text-xs text-muted-foreground">{row.sourceCount}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No politicians match your search.
        </div>
      )}
    </div>
  );
}
