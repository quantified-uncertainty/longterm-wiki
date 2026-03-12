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

export interface DivisionRow {
  id: string;
  slug: string | null;
  parentOrgId: string;
  /** Resolved display name for the parent org (set by server component) */
  parentOrgName?: string;
  name: string;
  divisionType: string;
  lead: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  website: string | null;
  source: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Status color helper
// ---------------------------------------------------------------------------

function statusColor(status: string | null): string {
  if (!status) return "text-muted-foreground";
  switch (status) {
    case "active":
      return "text-emerald-600";
    case "inactive":
      return "text-amber-500";
    case "dissolved":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<DivisionRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column} title="Division name">
        Name
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-sm font-medium max-w-[250px] truncate block"
        title={row.original.name}
      >
        {row.original.name}
      </span>
    ),
    filterFn: "includesString",
    size: 250,
  },
  {
    accessorKey: "parentOrgId",
    header: ({ column }) => (
      <SortableHeader column={column} title="Parent organization">
        Parent Org
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.parentOrgName ?? row.original.parentOrgId}
      </span>
    ),
    size: 160,
  },
  {
    accessorKey: "divisionType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Division type">
        Type
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground capitalize">
        {row.original.divisionType}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} title="Division status">
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
    accessorKey: "lead",
    header: ({ column }) => (
      <SortableHeader column={column} title="Division lead">
        Lead
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const v = row.original.lead;
      return v ? (
        <span className="text-xs text-muted-foreground">{v}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
    size: 140,
  },
  {
    accessorKey: "startDate",
    header: ({ column }) => (
      <SortableHeader column={column} title="Start date">
        Start
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.startDate;
      return d ? (
        <span className="text-xs tabular-nums text-muted-foreground">{d}</span>
      ) : (
        <span className="text-xs text-muted-foreground/30">-</span>
      );
    },
  },
  {
    accessorKey: "endDate",
    header: ({ column }) => (
      <SortableHeader column={column} title="End date">
        End
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.endDate;
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

export function DivisionsTable({ data }: { data: DivisionRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
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
            placeholder="Search divisions..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === data.length
            ? `${data.length} divisions`
            : `${filtered} of ${data.length} divisions`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
