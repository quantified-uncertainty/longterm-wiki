"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  flexRender,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { EntityCoverageRow } from "./statement-quality-content";

// ── Score bar ─────────────────────────────────────────────────────────────

function ScoreBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 80
      ? "bg-emerald-500"
      : pct >= 60
        ? "bg-blue-500"
        : pct >= 40
          ? "bg-amber-500"
          : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

// ── Category scores ───────────────────────────────────────────────────────

const CATEGORY_SHORT: Record<string, string> = {
  financial: "fin",
  safety: "safe",
  technical: "tech",
  organizational: "org",
  research: "res",
  relation: "rel",
  milestone: "ms",
};

function CategoryScores({ scores }: { scores: Record<string, number> }) {
  const entries = Object.entries(scores)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 6);

  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground/50">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([cat, score]) => {
        const pct = Math.round(score * 100);
        const color =
          pct >= 80
            ? "bg-emerald-500/15 text-emerald-700"
            : pct >= 60
              ? "bg-blue-500/15 text-blue-700"
              : pct >= 40
                ? "bg-amber-500/15 text-amber-700"
                : "bg-red-500/15 text-red-700";
        return (
          <span
            key={cat}
            className={`inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium ${color}`}
            title={`${cat}: ${pct}%`}
          >
            {CATEGORY_SHORT[cat] ?? cat}: {pct}%
          </span>
        );
      })}
    </div>
  );
}

// ── Table component ───────────────────────────────────────────────────────

interface Props {
  data: EntityCoverageRow[];
}

const ENTITY_TYPES = [
  "all",
  "organization",
  "person",
  "model",
  "concept",
  "policy",
  "risk",
  "other",
];

export function StatementQualityTable({ data }: Props) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "coverageScore", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const filtered = useMemo(() => {
    let result = data;
    if (typeFilter !== "all") {
      result = result.filter(
        (r) =>
          r.entityType === typeFilter ||
          (typeFilter === "organization" &&
            r.entityType.startsWith("organization"))
      );
    }
    return result;
  }, [data, typeFilter]);

  const columns: ColumnDef<EntityCoverageRow>[] = useMemo(
    () => [
      {
        accessorKey: "entityName",
        header: ({ column }) => (
          <SortableHeader column={column}>Entity</SortableHeader>
        ),
        cell: ({ row }) => (
          <Link
            href={row.original.entityHref}
            className="text-blue-600 hover:underline text-sm font-medium"
          >
            {row.original.entityName}
          </Link>
        ),
      },
      {
        accessorKey: "entityType",
        header: ({ column }) => (
          <SortableHeader column={column}>Type</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.entityType}
          </span>
        ),
      },
      {
        accessorKey: "coverageScore",
        header: ({ column }) => (
          <SortableHeader column={column}>Coverage</SortableHeader>
        ),
        cell: ({ row }) => (
          <ScoreBar value={row.original.coverageScore} />
        ),
        sortingFn: "basic",
      },
      {
        accessorKey: "qualityAvg",
        header: ({ column }) => (
          <SortableHeader column={column}>Avg Quality</SortableHeader>
        ),
        cell: ({ row }) => {
          const v = row.original.qualityAvg;
          if (v == null)
            return (
              <span className="text-xs text-muted-foreground/50">unscored</span>
            );
          return <ScoreBar value={v} />;
        },
        sortingFn: "basic",
      },
      {
        accessorKey: "statementCount",
        header: ({ column }) => (
          <SortableHeader column={column}>Stmts</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs tabular-nums">
            {row.original.statementCount}
          </span>
        ),
        sortingFn: "basic",
      },
      {
        accessorKey: "categoryScores",
        header: "Categories",
        cell: ({ row }) => (
          <CategoryScores scores={row.original.categoryScores} />
        ),
        enableSorting: false,
      },
      {
        accessorKey: "scoredAt",
        header: ({ column }) => (
          <SortableHeader column={column}>Last Scored</SortableHeader>
        ),
        cell: ({ row }) => {
          const d = new Date(row.original.scoredAt);
          return (
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              {d.toLocaleDateString()}
            </span>
          );
        },
        sortingFn: "datetime",
      },
    ],
    []
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Search entities…"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full h-8 pl-8 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {ENTITY_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                typeFilter === t
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background border-border hover:border-foreground/30"
              }`}
            >
              {t === "all"
                ? `All (${data.length})`
                : `${t} (${data.filter((r) => t === "organization" ? r.entityType.startsWith("organization") : r.entityType === t).length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground"
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="h-16 text-center text-sm text-muted-foreground"
                >
                  No matching entities.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-middle">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {table.getRowModel().rows.length} of {data.length} entities
      </p>
    </div>
  );
}
