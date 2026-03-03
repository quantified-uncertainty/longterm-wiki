"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  SortingState,
  VisibilityState,
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
import {
  formatStatementValue,
  getVarietyBadge,
  getStatusBadge,
} from "@/lib/statement-display";
import type { StatementRow, PropertyRow } from "./statements-content";

// ── Helpers ───────────────────────────────────────────────────────────────

function Badge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}

// ── Table Component ───────────────────────────────────────────────────────

interface StatementsTableProps {
  data: StatementRow[];
  properties: PropertyRow[];
}

export function StatementsTable({ data, properties }: StatementsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "subjectEntityId", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    sourceFactKey: false,
    note: false,
    validEnd: false,
  });

  // Build property lookup map
  const propertyMap = useMemo(() => {
    const map = new Map<string, PropertyRow>();
    for (const p of properties) {
      map.set(p.id, p);
    }
    return map;
  }, [properties]);

  const columns: ColumnDef<StatementRow>[] = useMemo(
    () => [
      {
        accessorKey: "subjectEntityId",
        header: ({ column }) => (
          <SortableHeader column={column}>Entity</SortableHeader>
        ),
        cell: ({ row }) => {
          const entityId = row.original.subjectEntityId;
          return (
            <Link
              href={`/wiki/${entityId}`}
              className="text-blue-600 hover:underline text-xs font-medium"
            >
              {entityId}
            </Link>
          );
        },
        size: 130,
      },
      {
        accessorKey: "propertyId",
        header: ({ column }) => (
          <SortableHeader column={column}>Property</SortableHeader>
        ),
        cell: ({ row }) => {
          const propId = row.original.propertyId;
          if (!propId) return <span className="text-muted-foreground text-xs">—</span>;
          const prop = propertyMap.get(propId);
          return (
            <span className="text-xs" title={prop?.description ?? propId}>
              {prop?.label ?? propId}
            </span>
          );
        },
        size: 140,
      },
      {
        id: "value",
        header: "Value",
        cell: ({ row }) => {
          const prop = row.original.propertyId
            ? propertyMap.get(row.original.propertyId)
            : null;
          const formatted = formatStatementValue(
            row.original,
            prop ? { unitFormatId: prop.unitFormatId, valueType: prop.valueType } : null
          );
          return (
            <span className="text-xs font-medium tabular-nums">
              {formatted}
            </span>
          );
        },
        size: 120,
      },
      {
        accessorKey: "variety",
        header: ({ column }) => (
          <SortableHeader column={column}>Variety</SortableHeader>
        ),
        cell: ({ row }) => {
          const badge = getVarietyBadge(row.original.variety);
          return <Badge label={badge.label} className={badge.className} />;
        },
        size: 90,
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <SortableHeader column={column}>Status</SortableHeader>
        ),
        cell: ({ row }) => {
          const badge = getStatusBadge(row.original.status);
          return <Badge label={badge.label} className={badge.className} />;
        },
        size: 80,
      },
      {
        accessorKey: "validStart",
        header: ({ column }) => (
          <SortableHeader column={column}>Valid From</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {row.original.validStart ?? "—"}
          </span>
        ),
        size: 90,
      },
      {
        accessorKey: "validEnd",
        header: ({ column }) => (
          <SortableHeader column={column}>Valid End</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {row.original.validEnd ?? "—"}
          </span>
        ),
        size: 90,
      },
      {
        id: "statementText",
        header: "Text",
        cell: ({ row }) => {
          const text = row.original.statementText;
          if (!text) return <span className="text-muted-foreground text-xs">—</span>;
          return (
            <span className="text-xs line-clamp-2" title={text}>
              {text}
            </span>
          );
        },
        size: 200,
      },
      {
        accessorKey: "sourceFactKey",
        header: "Source Key",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground font-mono">
            {row.original.sourceFactKey ?? "—"}
          </span>
        ),
        size: 120,
      },
      {
        accessorKey: "note",
        header: "Note",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground line-clamp-1">
            {row.original.note ?? "—"}
          </span>
        ),
        size: 150,
      },
    ],
    [propertyMap]
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search statements..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {table.getFilteredRowModel().rows.length} of {data.length}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
