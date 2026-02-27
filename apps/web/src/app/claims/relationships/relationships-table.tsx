"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RelationshipRow } from "@wiki-server/api-response-types";

export type { RelationshipRow };

function getColumns(entityNames: Record<string, string>): ColumnDef<RelationshipRow>[] {
  return [
  {
    accessorKey: "entityA",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity A</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/claims/entity/${row.original.entityA}`}
        className="text-blue-600 hover:underline text-sm"
      >
        {entityNames[row.original.entityA] ?? row.original.entityA}
      </Link>
    ),
  },
  {
    accessorKey: "entityB",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity B</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/claims/entity/${row.original.entityB}`}
        className="text-blue-600 hover:underline text-sm"
      >
        {entityNames[row.original.entityB] ?? row.original.entityB}
      </Link>
    ),
  },
  {
    accessorKey: "claimCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Claims</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono tabular-nums font-medium">
        {row.original.claimCount}
      </span>
    ),
  },
  {
    id: "sample",
    header: "Sample Claims",
    cell: ({ row }) => {
      const samples = row.original.sampleClaims;
      if (samples.length === 0)
        return <span className="text-muted-foreground">-</span>;
      return (
        <div className="space-y-1">
          {samples.slice(0, 2).map((s, i) => (
            <p
              key={i}
              className="text-xs text-muted-foreground"
              title={s}
            >
              {s.length > 120 ? s.slice(0, 120) + "..." : s}
            </p>
          ))}
        </div>
      );
    },
  },
];
}

export function RelationshipsTable({
  relationships,
  entityNames = {},
}: {
  relationships: RelationshipRow[];
  entityNames?: Record<string, string>;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "claimCount", desc: true },
  ]);
  const columns = getColumns(entityNames);

  const table = useReactTable({
    data: relationships,
    columns: columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });

  return (
    <div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
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
            <>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {/* Spacer row to maintain consistent table height across pages */}
              {table.getRowModel().rows.length < 25 && (
                <tr>
                  <td
                    colSpan={columns.length}
                    style={{ height: `${(25 - table.getRowModel().rows.length) * 37}px` }}
                  />
                </tr>
              )}
            </>
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="text-center text-muted-foreground py-8"
              >
                No relationships found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-2 py-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {relationships.length} relationships
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground px-2 tabular-nums">
              {table.getState().pagination.pageIndex + 1} /{" "}
              {table.getPageCount()}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
