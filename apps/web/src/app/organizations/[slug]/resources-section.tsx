"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Search, ChevronLeft, ChevronRight, AlertTriangle, Lock, Archive, LayoutList, Table2 } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { safeHref } from "@/lib/format-compact";
import type { OrgResourceRow } from "./org-data";
import { ResourceList } from "@/components/resources/ResourceList";
import { RESOURCE_TYPE_COLORS, STANCE_COLORS } from "@/components/resources/resource-constants";
import { stripMarkdownFormatting } from "@/lib/inline-markdown";
import { isDeadFetchStatus } from "@wiki-server/api-types";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";

const TYPE_COLORS = RESOURCE_TYPE_COLORS;
const DEFAULT_COLOR = RESOURCE_TYPE_COLORS._default;

/** Compute which optional columns have enough data to be worth showing. */
function computeColumnVisibility(
  resources: OrgResourceRow[],
  alwaysShow?: { date?: boolean; publication?: boolean; credibility?: boolean },
) {
  const total = resources.length || 1;
  const withDate = resources.filter((r) => r.publishedDate).length;
  const withPub = resources.filter((r) => r.publicationName).length;
  const withCred = resources.filter((r) => r.credibility != null).length;
  const withStance = resources.filter((r) => r.stance).length;
  const showPublication = alwaysShow?.publication || withPub / total >= 0.15;
  return {
    showDate: alwaysShow?.date || withDate / total >= 0.2,
    showPublication,
    showCredibility: alwaysShow?.credibility || withCred / total >= 0.15,
    showSource: !showPublication,
    showStance: withStance > 0,
  };
}

// STANCE_COLORS imported from resource-constants

function makeColumns(opts: {
  showDate: boolean;
  showPublication: boolean;
  showCredibility: boolean;
  showSource: boolean;
  showStance: boolean;
  verdicts: Record<string, string | null>;
}): ColumnDef<OrgResourceRow>[] {
  const cols: ColumnDef<OrgResourceRow>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="min-w-[200px] max-w-[400px]">
            <div className="flex items-start gap-1.5">
              <Link
                href={`/resources/${r.id}`}
                className="text-primary hover:underline text-xs font-medium line-clamp-2"
                title={stripMarkdownFormatting(r.title)}
              >
                {stripMarkdownFormatting(r.title)}
              </Link>
              {isDeadFetchStatus(r.fetchStatus) && (
                <span title="Link may be broken">
                  <AlertTriangle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
                </span>
              )}
              {r.fetchStatus === "paywall" && (
                <span title="Behind paywall">
                  <Lock className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
                </span>
              )}
            </div>
            {r.authors.length > 0 && (
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                {r.authors.slice(0, 3).map((a, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    {a.href ? (
                      <Link href={a.href} className="hover:text-primary hover:underline">
                        {a.name}
                      </Link>
                    ) : (
                      a.name
                    )}
                  </span>
                ))}
                {r.authors.length > 3 &&
                  ` +${r.authors.length - 3}`}
              </div>
            )}
            {r.summary && (
              <div className="text-[11px] text-muted-foreground/60 mt-0.5 line-clamp-1">
                {r.summary}
              </div>
            )}
          </div>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "type",
      header: ({ column }) => (
        <SortableHeader column={column}>Type</SortableHeader>
      ),
      cell: ({ row }) => {
        const t = row.original.type;
        const color = TYPE_COLORS[t] || DEFAULT_COLOR;
        return (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${color}`}>
            {t}
          </span>
        );
      },
    },
  ];

  if (opts.showStance) {
    cols.push({
      accessorKey: "stance",
      header: ({ column }) => (
        <SortableHeader column={column}>Stance</SortableHeader>
      ),
      cell: ({ row }) => {
        const s = row.original.stance;
        if (!s) return <span className="text-muted-foreground/40 text-xs">-</span>;
        const color = STANCE_COLORS[s] || DEFAULT_COLOR;
        return (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap capitalize ${color}`}>
            {s}
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  if (opts.showSource) {
    cols.push({
      id: "source",
      accessorFn: (row) => row.domain,
      header: ({ column }) => (
        <SortableHeader column={column}>Source</SortableHeader>
      ),
      cell: ({ row }) => {
        const domain = row.original.domain;
        if (!domain) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground max-w-[140px] truncate block" title={domain}>
            {domain}
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  if (opts.showPublication) {
    cols.push({
      accessorKey: "publicationName",
      header: ({ column }) => (
        <SortableHeader column={column}>Publication</SortableHeader>
      ),
      cell: ({ row }) => {
        const p = row.original.publicationName;
        const domain = row.original.domain;
        if (p) {
          return (
            <span className="text-xs text-muted-foreground italic max-w-[140px] truncate block" title={p}>
              {p}
            </span>
          );
        }
        // Fallback: show domain when no publication is linked
        if (domain) {
          return (
            <span className="text-xs text-muted-foreground/60 max-w-[140px] truncate block" title={domain}>
              {domain}
            </span>
          );
        }
        return <span className="text-muted-foreground/40 text-xs">-</span>;
      },
      sortUndefined: "last",
    });
  }

  if (opts.showDate) {
    cols.push({
      accessorKey: "publishedDate",
      header: ({ column }) => (
        <SortableHeader column={column}>Published</SortableHeader>
      ),
      cell: ({ row }) => {
        const d = row.original.publishedDate;
        if (!d) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
            {d.slice(0, 10)}
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  if (opts.showCredibility) {
    cols.push({
      accessorKey: "credibility",
      header: ({ column }) => (
        <SortableHeader column={column}>Cred.</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original.credibility;
        if (c == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
        const color =
          c >= 4 ? "text-emerald-600"
            : c >= 3 ? "text-blue-500"
              : c >= 2 ? "text-amber-600"
                : "text-red-500";
        return (
          <span className={`text-xs font-medium tabular-nums ${color}`}>
            {c}/5
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  cols.push(
    {
      accessorKey: "citingPageCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Citing Pages</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.citingPageCount || "-"}
        </span>
      ),
    },
    {
      id: "coverage",
      header: "",
      cell: ({ row }) => {
        const r = row.original;
        const filledFieldCount =
          (r.publishedDate ? 1 : 0) +
          (r.publicationName ? 1 : 0) +
          (r.credibility != null ? 1 : 0);
        const score = computeGenericCoverage({
          description: r.summary,
          filledFieldCount,
        });
        const verdict = opts.verdicts[r.id] ?? null;
        return (
          <div className="flex justify-end">
            <RecordStatusDots
              coverageScore={score}
              verdict={verdict}
              sourceCheckHref={verdict ? `/source-checks/resource/${encodeURIComponent(r.id)}` : undefined}
              size="md"
            />
          </div>
        );
      },
      enableSorting: false,
    },
    {
      id: "link",
      header: "",
      cell: ({ row }) => {
        const r = row.original;
        const isDead = isDeadFetchStatus(r.fetchStatus);
        const archiveHref = isDead && r.archiveUrl ? safeHref(r.archiveUrl) : null;
        return (
          <div className="flex items-center gap-1">
            {archiveHref && (
              <a
                href={archiveHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary"
                title="View archived version"
              >
                <Archive className="h-3.5 w-3.5" />
              </a>
            )}
            <a
              href={safeHref(r.url)}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs ${isDead ? "text-muted-foreground/40" : "text-primary hover:text-primary/80"}`}
              title={isDead ? `Link may be broken: ${r.url}` : r.url}
            >
              &#8599;
            </a>
          </div>
        );
      },
      enableSorting: false,
    },
  );

  return cols;
}

type ViewMode = "table" | "card";

export function OrgResourcesSection({
  resources,
  title,
  emptyMessage,
  alwaysShowColumns,
  defaultView = "table",
  verdicts = {},
}: {
  resources: OrgResourceRow[];
  title: string;
  emptyMessage: string;
  alwaysShowColumns?: { date?: boolean; publication?: boolean; credibility?: boolean };
  defaultView?: ViewMode;
  /** Map of resource ID → verdict string (e.g. "confirmed", "contradicted"). Computed server-side. */
  verdicts?: Record<string, string | null>;
}) {
  const [view, setView] = useState<ViewMode>(defaultView);

  if (resources.length === 0) {
    return (
      <section>
        <h3 className="text-lg font-bold tracking-tight mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>
      </section>
    );
  }

  if (view === "card") {
    return (
      <section>
        <div className="flex items-center justify-between mb-2">
          <div /> {/* spacer — ResourceList renders its own header */}
          <ViewToggle view={view} onChange={setView} />
        </div>
        <ResourceList resources={resources} title={title} emptyMessage={emptyMessage} />
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-end mb-1">
        <ViewToggle view={view} onChange={setView} />
      </div>
      <OrgResourcesTable resources={resources} title={title} alwaysShowColumns={alwaysShowColumns} verdicts={verdicts} />
    </section>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5">
      <button
        onClick={() => onChange("table")}
        className={`p-1 rounded transition-colors ${view === "table" ? "bg-muted text-foreground" : "text-muted-foreground/50 hover:text-muted-foreground"}`}
        title="Table view"
      >
        <Table2 className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => onChange("card")}
        className={`p-1 rounded transition-colors ${view === "card" ? "bg-muted text-foreground" : "text-muted-foreground/50 hover:text-muted-foreground"}`}
        title="Card view"
      >
        <LayoutList className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function OrgResourcesTable({
  resources,
  title,
  alwaysShowColumns,
  verdicts,
}: {
  resources: OrgResourceRow[];
  title: string;
  alwaysShowColumns?: { date?: boolean; publication?: boolean; credibility?: boolean };
  verdicts: Record<string, string | null>;
}) {
  const colVis = useMemo(() => computeColumnVisibility(resources, alwaysShowColumns), [resources, alwaysShowColumns]);
  const columns = useMemo(() => makeColumns({ ...colVis, verdicts }), [colVis, verdicts]);

  const [sorting, setSorting] = useState<SortingState>(
    colVis.showDate
      ? [{ id: "publishedDate", desc: true }]
      : [{ id: "title", desc: false }],
  );
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) {
      counts.set(r.type, (counts.get(r.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const filteredData = useMemo(() => {
    let data = resources;
    if (typeFilter) data = data.filter((r) => r.type === typeFilter);
    return data;
  }, [resources, typeFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: { sorting, globalFilter, pagination },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = resources.length;

  return (
    <div className="space-y-3">
      {/* Header + toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-bold tracking-tight">
          {title}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({filtered === total ? total : `${filtered} of ${total}`})
          </span>
        </h3>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-8 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {types.length > 1 && (
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs shadow-sm"
          >
            <option value="">All types</option>
            {types.map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 shadow-sm max-h-[60vh] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b-2 border-border/60"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                  No resources match your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-1">
          <select
            value={pagination.pageSize}
            onChange={(e) =>
              setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })
            }
            className="h-7 rounded border border-border bg-background px-2 text-xs"
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>{size} per page</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Page {pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
