"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";

export interface ApproachRow {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  numericId: string | null;
}

type SortKey = "title" | "tags";
type SortDir = "asc" | "desc";

export function ApproachesTable({ rows }: { rows: ApproachRow[] }) {
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
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      switch (sortKey) {
        case "title":
          return a.title.localeCompare(b.title) * dir;
        case "tags":
          return (a.tags.length - b.tags.length) * dir;
      }
    });

    return result;
  }, [rows, search, sortKey, sortDir]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search approaches by name, description, or tag..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-80"
        />
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} approaches
      </div>

      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <SortHeader
                label="Name"
                sortKey="title"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <th className="text-left py-2 px-3 font-medium">Description</th>
              <SortHeader
                label="Tags"
                sortKey="tags"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <th className="text-center py-2 px-3 font-medium">Wiki</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
              >
                <td className="py-2.5 px-3 min-w-[180px]">
                  <Link
                    href={`/approaches/${row.id}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.title}
                  </Link>
                </td>

                <td className="py-2.5 px-3 text-muted-foreground max-w-[400px]">
                  {row.description && (
                    <span className="line-clamp-2 text-xs">
                      {row.description}
                    </span>
                  )}
                </td>

                <td className="py-2.5 px-3 max-w-[200px]">
                  {row.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {row.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </td>

                <td className="py-2.5 px-3 text-center whitespace-nowrap">
                  {row.numericId && (
                    <Link
                      href={`/wiki/${row.numericId}`}
                      className="text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No approaches match your search.
        </div>
      )}
    </div>
  );
}
