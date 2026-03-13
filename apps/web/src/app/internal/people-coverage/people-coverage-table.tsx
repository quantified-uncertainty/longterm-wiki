"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

export interface PersonCoverageRow {
  id: string;
  numericId: string;
  name: string;
  hasRole: boolean;
  hasEmployer: boolean;
  hasBornYear: boolean;
  hasNotableFor: boolean;
  hasExpertPositions: boolean;
  hasWikiPage: boolean;
  hasCareerHistory: boolean;
  hasKBFacts: boolean;
  kbFactCount: number;
  completenessScore: number;
  totalFields: number;
}

// ── Cell renderers ─────────────────────────────────────────────────────

function BoolIcon({ value, label }: { value: boolean; label: string }) {
  return value ? (
    <span className="text-emerald-500 text-sm font-bold" title={label}>
      ✓
    </span>
  ) : (
    <span className="text-red-400/60 text-sm" title={label}>
      ✗
    </span>
  );
}

function ScoreBadge({ score, total }: { score: number; total: number }) {
  const pct = score / total;
  const color =
    pct >= 0.75
      ? "bg-emerald-500/15 text-emerald-600"
      : pct >= 0.5
        ? "bg-amber-500/15 text-amber-600"
        : "bg-red-500/15 text-red-600";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] tabular-nums font-bold ${color}`}
    >
      {score}/{total}
    </span>
  );
}

// ── Column definitions ─────────────────────────────────────────────────

const columns: ColumnDef<PersonCoverageRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column} title="Person name">
        Name
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const { numericId, name, hasWikiPage } = row.original;
      if (hasWikiPage && numericId) {
        return (
          <Link
            href={`/wiki/${numericId}`}
            className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[200px] truncate block"
          >
            {name}
          </Link>
        );
      }
      return (
        <span className="text-sm font-medium text-muted-foreground max-w-[200px] truncate block">
          {name}
        </span>
      );
    },
    filterFn: "includesString",
    size: 200,
  },
  {
    accessorKey: "hasRole",
    header: ({ column }) => (
      <SortableHeader column={column} title="Has role in KB facts or entity data">
        Role
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasRole} label="Has Role" />
    ),
  },
  {
    accessorKey: "hasEmployer",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        title="Has employed-by in KB facts or affiliation in entity"
      >
        Employer
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasEmployer} label="Has Employer" />
    ),
  },
  {
    accessorKey: "hasBornYear",
    header: ({ column }) => (
      <SortableHeader column={column} title="Has born-year KB fact">
        Born
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasBornYear} label="Has Born Year" />
    ),
  },
  {
    accessorKey: "hasNotableFor",
    header: ({ column }) => (
      <SortableHeader column={column} title="Has notable-for KB fact">
        Notable
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasNotableFor} label="Has Notable For" />
    ),
  },
  {
    accessorKey: "hasExpertPositions",
    header: ({ column }) => (
      <SortableHeader column={column} title="Has expert positions in experts.yaml">
        Positions
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon
        value={row.original.hasExpertPositions}
        label="Has Expert Positions"
      />
    ),
  },
  {
    accessorKey: "hasWikiPage",
    header: ({ column }) => (
      <SortableHeader column={column} title="Has a wiki page in content/docs/">
        Page
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasWikiPage} label="Has Wiki Page" />
    ),
  },
  {
    accessorKey: "hasCareerHistory",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        title="Has 2+ employed-by KB facts (career history)"
      >
        Career
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <BoolIcon value={row.original.hasCareerHistory} label="Has Career History" />
    ),
  },
  {
    accessorKey: "kbFactCount",
    header: ({ column }) => (
      <SortableHeader column={column} title="Total KB facts for this person">
        Facts
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const count = row.original.kbFactCount;
      const color =
        count >= 5
          ? "text-emerald-600"
          : count >= 2
            ? "text-amber-600"
            : count > 0
              ? "text-blue-500"
              : "text-muted-foreground/30";
      return (
        <span className={`text-xs tabular-nums font-medium ${color}`}>
          {count}
        </span>
      );
    },
  },
  {
    accessorKey: "completenessScore",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        title="Completeness score: fields present out of 8"
      >
        Score
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreBadge
        score={row.original.completenessScore}
        total={row.original.totalFields}
      />
    ),
  },
];

// ── Table component ────────────────────────────────────────────────────

export function PeopleCoverageTable({ data }: { data: PersonCoverageRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "completenessScore", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: { sorting, globalFilter },
  });

  const filtered = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search people..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === data.length
            ? `${data.length} people`
            : `${filtered} of ${data.length} people`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
