"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";

export interface ProjectRow {
  id: string;
  title: string;
  description: string | null;
  numericId: string | null;
  status: string | null;
  website: string | null;
  clusters: string[];
  orgName: string | null;
  orgHref: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  maintained: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  beta: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  abandoned: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

type SortKey = "title" | "status" | "org";
type SortDir = "asc" | "desc";

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

export function ProjectsTable({ rows }: { rows: ProjectRow[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          (r.description && r.description.toLowerCase().includes(q)) ||
          (r.orgName && r.orgName.toLowerCase().includes(q)),
      );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      switch (sortKey) {
        case "title":
          return a.title.localeCompare(b.title) * dir;
        case "status":
          return (a.status ?? "").localeCompare(b.status ?? "") * dir;
        case "org":
          return (a.orgName ?? "").localeCompare(b.orgName ?? "") * dir;
      }
    });

    return result;
  }, [rows, search, sortKey, sortDir]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} projects
      </div>

      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader label="Project" sortKey="title" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <th className="text-left py-2 px-3 font-medium">Description</th>
              <SortHeader label="Organization" sortKey="org" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Status" sortKey="status" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <th className="text-center py-2 px-3 font-medium">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                <td className="py-2.5 px-3 min-w-[160px]">
                  <Link
                    href={`/projects/${row.id}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.title}
                  </Link>
                </td>

                <td className="py-2.5 px-3 text-muted-foreground max-w-[320px]">
                  {row.description && (
                    <span className="line-clamp-2 text-xs">{row.description}</span>
                  )}
                </td>

                <td className="py-2.5 px-3">
                  {row.orgName && row.orgHref ? (
                    <Link href={row.orgHref} className="text-xs text-foreground hover:text-primary transition-colors">
                      {row.orgName}
                    </Link>
                  ) : row.orgName ? (
                    <span className="text-xs text-muted-foreground">{row.orgName}</span>
                  ) : null}
                </td>

                <td className="py-2.5 px-3 text-center">
                  {row.status && (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${STATUS_COLORS[row.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {row.status}
                    </span>
                  )}
                </td>

                <td className="py-2.5 px-3 text-center whitespace-nowrap">
                  <div className="flex items-center justify-center gap-2">
                    {row.website && (
                      <a href={row.website} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline">
                        {safeHostname(row.website)}
                      </a>
                    )}
                    {row.numericId && (
                      <Link href={`/wiki/${row.numericId}`} className="text-[10px] text-muted-foreground/50 hover:text-primary transition-colors" title="Wiki page">
                        wiki
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No projects match your search.
        </div>
      )}
    </div>
  );
}
