"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

export interface PersonRow {
  id: string;
  name: string;
  numericId: string | null;
  wikiPageId: string | null;

  role: string | null;

  employerId: string | null;
  employerName: string | null;

  bornYear: number | null;

  netWorth: string | null;
  netWorthNum: number | null;

  careerHistoryCount: number;
}

type SortKey =
  | "name"
  | "role"
  | "employer"
  | "bornYear"
  | "netWorth"
  | "careerHistory";

type SortDir = "asc" | "desc";

function formatCompactCurrency(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function SortHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = currentSort === sortKey;
  return (
    <th
      className={`py-2.5 px-3 font-medium cursor-pointer select-none hover:text-foreground transition-colors ${
        isActive ? "text-foreground" : ""
      } ${className ?? ""}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive && (
          <span className="text-[10px]">
            {currentDir === "asc" ? "\u25B2" : "\u25BC"}
          </span>
        )}
      </span>
    </th>
  );
}

export function PeopleTable({ rows }: { rows: PersonRow[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
  }, [rows, search, sortKey, sortDir]);

  return (
    <div>
      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search people..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
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
                    href={`/kb/entity/${row.id}`}
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
