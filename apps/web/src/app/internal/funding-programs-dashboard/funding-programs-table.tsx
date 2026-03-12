"use client";

import { useState } from "react";
import type {
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FundingProgramRow {
  id: string;
  orgId: string;
  /** Resolved display name for the org (set by server component) */
  orgName?: string;
  divisionId: string | null;
  name: string;
  description: string | null;
  programType: string;
  totalBudget: number | null;
  currency: string;
  applicationUrl: string | null;
  openDate: string | null;
  deadline: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBudget(amount: number | null, currency: string): string {
  if (amount == null) return "-";
  if (currency === "USD") {
    if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
    if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
    if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
    return `$${amount.toLocaleString()}`;
  }
  return `${amount.toLocaleString()} ${currency}`;
}

// ---------------------------------------------------------------------------
// Status color helper
// ---------------------------------------------------------------------------

function statusColor(status: string | null): string {
  if (!status) return "text-muted-foreground";
  switch (status) {
    case "open":
      return "text-emerald-600";
    case "closed":
      return "text-red-500";
    case "awarded":
      return "text-blue-500";
    default:
      return "text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<FundingProgramRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column} title="Program name">
        Name
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const url = row.original.applicationUrl;
      return url ? (
        <a
          href={url.startsWith("http") ? url : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[280px] truncate block"
          title={row.original.name}
        >
          {row.original.name}
        </a>
      ) : (
        <span
          className="text-sm font-medium max-w-[280px] truncate block"
          title={row.original.name}
        >
          {row.original.name}
        </span>
      );
    },
    filterFn: "includesString",
    size: 280,
  },
  {
    accessorKey: "orgId",
    header: ({ column }) => (
      <SortableHeader column={column} title="Organization">
        Org
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.orgName ?? row.original.orgId}
      </span>
    ),
    size: 140,
  },
  {
    accessorKey: "programType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Program type">
        Type
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground capitalize">
        {row.original.programType}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "totalBudget",
    header: ({ column }) => (
      <SortableHeader column={column} title="Total budget">
        Budget
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium text-foreground">
        {formatBudget(row.original.totalBudget, row.original.currency)}
      </span>
    ),
    sortUndefined: "last",
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} title="Program status">
        Status
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const s = row.original.status;
      if (!s) return <span className="text-xs text-muted-foreground/30">-</span>;
      return (
        <span className={`text-xs font-medium ${statusColor(s)}`}>{s}</span>
      );
    },
    size: 80,
  },
  {
    accessorKey: "openDate",
    header: ({ column }) => (
      <SortableHeader column={column} title="Open date">
        Open
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.openDate;
      return d ? (
        <span className="text-xs tabular-nums text-muted-foreground">{d}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
  },
  {
    accessorKey: "deadline",
    header: ({ column }) => (
      <SortableHeader column={column} title="Deadline">
        Deadline
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.deadline;
      return d ? (
        <span className="text-xs tabular-nums text-muted-foreground">{d}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Table component
// ---------------------------------------------------------------------------

export function FundingProgramsTable({ data }: { data: FundingProgramRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "totalBudget", desc: true },
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
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search programs..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === data.length
            ? `${data.length} programs`
            : `${filtered} of ${data.length} programs`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
