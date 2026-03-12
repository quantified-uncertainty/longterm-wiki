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

export interface GrantRow {
  id: string;
  organizationId: string;
  granteeId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  period: string | null;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAmount(amount: number | null, currency: string): string {
  if (amount == null) return "-";
  if (currency === "USD") {
    if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
    if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
    return `$${amount.toLocaleString()}`;
  }
  return `${amount.toLocaleString()} ${currency}`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<GrantRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant name">
        Name
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const source = row.original.source;
      return source ? (
        <a
          href={source.startsWith("http") ? source : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[300px] truncate block"
          title={row.original.name}
        >
          {row.original.name}
        </a>
      ) : (
        <span
          className="text-sm font-medium max-w-[300px] truncate block"
          title={row.original.name}
        >
          {row.original.name}
        </span>
      );
    },
    filterFn: "includesString",
    size: 300,
  },
  {
    accessorKey: "organizationId",
    header: ({ column }) => (
      <SortableHeader column={column} title="Funding organization">
        Funder
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.organizationId}
      </span>
    ),
    size: 140,
  },
  {
    accessorKey: "granteeId",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant recipient">
        Grantee
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const v = row.original.granteeId;
      return v ? (
        <span className="text-xs text-muted-foreground">{v}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
    size: 140,
  },
  {
    accessorKey: "amount",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant amount">
        Amount
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium text-foreground">
        {formatAmount(row.original.amount, row.original.currency)}
      </span>
    ),
    sortUndefined: "last",
  },
  {
    accessorKey: "date",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant date">
        Date
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.date;
      return d ? (
        <span className="text-xs tabular-nums text-muted-foreground">{d}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
  },
  {
    accessorKey: "period",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant period">
        Period
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const p = row.original.period;
      return p ? (
        <span className="text-xs text-muted-foreground">{p}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} title="Grant status">
        Status
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const s = row.original.status;
      if (!s) return <span className="text-xs text-muted-foreground/30">-</span>;
      const color =
        s === "active"
          ? "text-emerald-600"
          : s === "completed"
            ? "text-blue-500"
            : "text-muted-foreground";
      return <span className={`text-xs font-medium ${color}`}>{s}</span>;
    },
  },
];

// ---------------------------------------------------------------------------
// Table component
// ---------------------------------------------------------------------------

export function GrantsTable({ data }: { data: GrantRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "amount", desc: true },
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
            placeholder="Search grants..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === data.length
            ? `${data.length} grants`
            : `${filtered} of ${data.length} grants`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
