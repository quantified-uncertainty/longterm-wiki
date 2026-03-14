"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import { CLUSTER_COLORS, STATUS_COLORS, formatCluster, formatFunding } from "./research-area-constants";

export interface ResearchAreaRow {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  status: string;
  cluster: string | null;
  parentAreaId: string | null;
  firstProposedYear: number | null;
  orgCount: number;
  paperCount: number;
  grantCount: number;
  totalFunding: string;
  riskCount: number;
}

type SortKey = "title" | "cluster" | "status" | "orgCount" | "paperCount" | "grantCount" | "totalFunding" | "firstProposedYear";

export function ResearchAreasTable({ rows }: { rows: ResearchAreaRow[] }) {
  const [search, setSearch] = useState("");
  const [clusterFilter, setClusterFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("grantCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const clusters = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.cluster) set.add(r.cluster);
    }
    return [...set].sort();
  }, [rows]);

  const clusterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const c = r.cluster ?? "uncategorized";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows
      .filter((r) => {
        if (clusterFilter !== "all" && r.cluster !== clusterFilter) return false;
        if (statusFilter !== "all" && r.status !== statusFilter) return false;
        if (q) {
          return (
            r.title.toLowerCase().includes(q) ||
            (r.description?.toLowerCase().includes(q) ?? false) ||
            (r.cluster?.toLowerCase().includes(q) ?? false)
          );
        }
        return true;
      })
      .sort((a, b) => {
        const getValue = (row: ResearchAreaRow): string | number | null => {
          switch (sortKey) {
            case "title": return row.title.toLowerCase();
            case "cluster": return row.cluster ?? "";
            case "status": return row.status;
            case "orgCount": return row.orgCount;
            case "paperCount": return row.paperCount;
            case "grantCount": return row.grantCount;
            case "totalFunding": return parseFloat(row.totalFunding);
            case "firstProposedYear": return row.firstProposedYear ?? 0;
          }
        };
        return compareByValue(a, b, getValue, sortDir);
      });
  }, [rows, search, clusterFilter, statusFilter, sortKey, sortDir]);

  const handleSort = (key: string) => {
    const k = key as SortKey;
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "title" ? "asc" : "desc");
    }
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Search research areas..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm flex-1 min-w-0"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="emerging">Emerging</option>
          <option value="mature">Mature</option>
          <option value="declining">Declining</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Cluster filter pills */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        <button
          onClick={() => setClusterFilter("all")}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
            clusterFilter === "all"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          All ({clusterCounts.all})
        </button>
        {clusters.map((c) => (
          <button
            key={c}
            onClick={() => setClusterFilter(c)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              clusterFilter === c
                ? "bg-foreground text-background"
                : CLUSTER_COLORS[c] ?? "bg-muted text-muted-foreground"
            }`}
          >
            {formatCluster(c)} ({clusterCounts[c] ?? 0})
          </button>
        ))}
      </div>

      <div className="text-xs text-muted-foreground mb-2">
        {filtered.length} of {rows.length} research areas
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <SortHeader label="Name" sortKey="title" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
              <SortHeader label="Cluster" sortKey="cluster" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
              <SortHeader label="Status" sortKey="status" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} />
              <SortHeader label="Orgs" sortKey="orgCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Papers" sortKey="paperCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Grants" sortKey="grantCount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Funding" sortKey="totalFunding" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Since" sortKey="firstProposedYear" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-muted-foreground">
                  No research areas match your filters.
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border/30 hover:bg-muted/20 transition-colors"
              >
                <td className="px-3 py-2.5">
                  <div className="flex flex-col">
                    <Link
                      href={`/research-areas/${row.id}`}
                      className="font-medium text-foreground hover:text-primary transition-colors"
                    >
                      {row.title}
                    </Link>
                    {row.description && (
                      <span className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                        {row.description}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {row.cluster && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        CLUSTER_COLORS[row.cluster] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {formatCluster(row.cluster)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`text-xs font-medium ${STATUS_COLORS[row.status] ?? ""}`}>
                    {row.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{row.orgCount ?? "-"}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{row.paperCount ?? "-"}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{row.grantCount ?? "-"}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatFunding(row.totalFunding)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {row.firstProposedYear ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
