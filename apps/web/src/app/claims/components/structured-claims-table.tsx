"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState, ExpandedState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ClaimRow } from "@wiki-server/api-types";
import { formatStructuredValue } from "@lib/format-value";

interface Props {
  claims: ClaimRow[];
  propertyLabels: Record<string, string>;
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  // Handle YYYY-MM-DD or YYYY-MM or YYYY
  const parts = dateStr.split("-");
  if (parts.length >= 2) {
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const monthIdx = parseInt(parts[1], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]} ${parts[0]}`;
    }
  }
  return dateStr;
}

function getColumns(propertyLabels: Record<string, string>): ColumnDef<ClaimRow>[] {
  return [
    {
      id: "expand",
      header: "",
      cell: ({ row }) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
          className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {row.getIsExpanded() ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      ),
      size: 30,
    },
    {
      id: "property",
      accessorFn: (row) => row.property,
      header: ({ column }) => (
        <SortableHeader column={column}>Property</SortableHeader>
      ),
      cell: ({ row }) => {
        const prop = row.original.property;
        if (!prop) return null;
        const label = propertyLabels[prop] ?? prop.replace(/_/g, " ");
        return (
          <span className="text-xs font-medium" title={prop}>
            {label}
          </span>
        );
      },
      size: 140,
    },
    {
      id: "value",
      accessorFn: (row) => row.structuredValue,
      header: ({ column }) => (
        <SortableHeader column={column}>Value</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original;
        if (!c.structuredValue) return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
        const formatted = formatStructuredValue(c.structuredValue, c.valueUnit);
        return (
          <span className="text-xs font-mono font-medium text-emerald-700" title={`${c.structuredValue}${c.valueUnit ? ` [${c.valueUnit}]` : ""}`}>
            {formatted}
          </span>
        );
      },
      size: 120,
    },
    {
      id: "date",
      accessorFn: (row) => row.valueDate,
      header: ({ column }) => (
        <SortableHeader column={column}>Date</SortableHeader>
      ),
      cell: ({ row }) => {
        const dateStr = row.original.valueDate;
        if (!dateStr) return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
        return (
          <span className="text-xs text-muted-foreground">
            {formatDate(dateStr)}
          </span>
        );
      },
      size: 80,
    },
    {
      id: "qualifiers",
      accessorFn: (row) => row.qualifiers ? Object.keys(row.qualifiers).length : 0,
      header: "Qualifiers",
      cell: ({ row }) => {
        const quals = row.original.qualifiers;
        if (!quals || Object.keys(quals).length === 0) {
          return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {Object.entries(quals).map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700 border border-amber-200"
              >
                <span className="text-amber-500">{k}:</span> {v}
              </span>
            ))}
          </div>
        );
      },
      size: 140,
    },
    {
      id: "source",
      header: "Source",
      cell: ({ row }) => {
        const sources = row.original.sources;
        if (!sources || sources.length === 0) {
          return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
        }
        const primary = sources.find((s) => s.isPrimary) ?? sources[0];
        if (primary.resourceId) {
          return (
            <Link
              href={`/source/${primary.resourceId}`}
              className="text-[10px] text-blue-600 hover:underline font-mono truncate block max-w-[120px]"
              onClick={(e) => e.stopPropagation()}
            >
              {primary.resourceId}
            </Link>
          );
        }
        if (primary.url) {
          try {
            const hostname = new URL(primary.url).hostname.replace("www.", "");
            return (
              <a
                href={primary.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-blue-600 hover:underline truncate block max-w-[120px]"
                onClick={(e) => e.stopPropagation()}
              >
                {hostname}
              </a>
            );
          } catch {
            return <span className="text-[10px] text-muted-foreground truncate">{primary.url}</span>;
          }
        }
        return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
      },
      size: 120,
    },
    {
      id: "claimText",
      header: "Claim",
      cell: ({ row }) => {
        const text = row.original.claimText;
        return (
          <span className="text-xs text-muted-foreground" title={text}>
            {text.length > 100 ? text.slice(0, 100) + "..." : text}
          </span>
        );
      },
      size: 280,
    },
  ];
}

export function StructuredClaimsTable({ claims, propertyLabels }: Props) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "property", desc: false },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const columns = getColumns(propertyLabels);

  const table = useReactTable({
    data: claims,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowCanExpand: () => true,
  });

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  style={{ width: header.getSize() }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => row.toggleExpanded()}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext()
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="text-center text-muted-foreground py-8"
              >
                No structured claims found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
