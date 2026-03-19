"use client";

import { useState, useMemo } from "react";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { OrgResourceRow } from "@/app/organizations/[slug]/org-data";
import { ResourceCard } from "./ResourceCard";

/**
 * Resource list with card view, search, type filter, and pagination.
 * Offers a card-based display as an alternative to the table view.
 */
export function ResourceList({
  resources,
  title,
  emptyMessage = "No resources found.",
}: {
  resources: OrgResourceRow[];
  title: string;
  emptyMessage?: string;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const filtered = useMemo(() => {
    let items = resources;
    if (typeFilter) items = items.filter((r) => r.type === typeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        (r.publicationName?.toLowerCase().includes(q)) ||
        (r.domain?.toLowerCase().includes(q)) ||
        r.authors.some((a) => a.name.toLowerCase().includes(q)) ||
        (r.summary?.toLowerCase().includes(q))
      );
    }
    return items;
  }, [resources, typeFilter, search]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageItems = filtered.slice(page * pageSize, (page + 1) * pageSize);

  if (resources.length === 0) {
    return (
      <section>
        <h3 className="text-lg font-bold tracking-tight mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-bold tracking-tight">
          {title}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({filtered.length === resources.length ? resources.length : `${filtered.length} of ${resources.length}`})
          </span>
        </h3>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="h-8 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        {types.length > 1 && (
          <select
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs shadow-sm"
          >
            <option value="">All types</option>
            {types.map(([t, c]) => (
              <option key={t} value={t}>{t} ({c})</option>
            ))}
          </select>
        )}
      </div>

      {/* Card list */}
      <div className="rounded-lg border border-border/60 shadow-sm px-4">
        {pageItems.length > 0 ? (
          pageItems.map((r) => <ResourceCard key={r.id} resource={r} />)
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No resources match your filters.
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-1">
          <select
            value={pageSize}
            disabled
            className="h-7 rounded border border-border bg-background px-2 text-xs opacity-50"
          >
            <option value={25}>25 per page</option>
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
