"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState, ExpandedState } from "@tanstack/react-table";
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
  ChevronDown,
  ChevronRight as ChevronRightIcon,
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
import type { ClaimRow } from "@wiki-server/api-types";
import { CategoryBadge } from "./category-badge";
import { ConfidenceBadge } from "./confidence-badge";

function ExpandedClaimDetail({ claim }: { claim: ClaimRow }) {
  return (
    <div className="px-4 py-3 bg-muted/30 space-y-2 text-sm">
      <div>
        <span className="font-medium text-xs text-muted-foreground">
          Full Claim:
        </span>
        <p className="mt-0.5">{claim.claimText}</p>
      </div>
      {claim.sourceQuote && (
        <div>
          <span className="font-medium text-xs text-muted-foreground">
            Source Quote:
          </span>
          <p className="mt-0.5 italic text-muted-foreground">
            &ldquo;{claim.sourceQuote}&rdquo;
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-xs">
        {claim.section && (
          <span>
            <span className="text-muted-foreground">Section:</span>{" "}
            {claim.section}
          </span>
        )}
        {claim.factId && (
          <span>
            <span className="text-muted-foreground">Fact:</span>{" "}
            <span className="font-mono">{claim.factId}</span>
          </span>
        )}
        {claim.relatedEntities && claim.relatedEntities.length > 0 && (
          <span>
            <span className="text-muted-foreground">Related:</span>{" "}
            {claim.relatedEntities.map((eid) => (
              <Link
                key={eid}
                href={`/claims/entity/${eid}`}
                className="text-blue-600 hover:underline ml-1"
              >
                {eid}
              </Link>
            ))}
          </span>
        )}
      </div>
      <div className="pt-1">
        <Link
          href={`/claims/claim/${claim.id}`}
          className="text-xs text-blue-600 hover:underline"
        >
          View full detail &rarr;
        </Link>
      </div>
    </div>
  );
}

const columns: ColumnDef<ClaimRow>[] = [
  {
    id: "expand",
    header: "",
    cell: ({ row }) => (
      <button
        type="button"
        onClick={() => row.toggleExpanded()}
        className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        {row.getIsExpanded() ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5" />
        )}
      </button>
    ),
    size: 30,
  },
  {
    accessorKey: "entityId",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/claims/entity/${row.original.entityId}`}
        className="font-mono text-blue-600 hover:underline text-xs"
      >
        {row.original.entityId}
      </Link>
    ),
    size: 120,
  },
  {
    accessorKey: "claimText",
    header: "Claim",
    cell: ({ row }) => (
      <span
        className="text-xs leading-relaxed"
        title={row.original.claimText}
      >
        {row.original.claimText.length > 200
          ? row.original.claimText.slice(0, 200) + "..."
          : row.original.claimText}
      </span>
    ),
    size: 400,
  },
  {
    accessorKey: "claimType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-[10px]">{row.original.claimType}</span>
    ),
    size: 80,
  },
  {
    accessorKey: "claimCategory",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <CategoryBadge
        category={row.original.claimCategory ?? "uncategorized"}
      />
    ),
    size: 90,
  },
  {
    accessorKey: "confidence",
    header: ({ column }) => (
      <SortableHeader column={column}>Confidence</SortableHeader>
    ),
    cell: ({ row }) => (
      <ConfidenceBadge
        confidence={row.original.confidence ?? "unverified"}
      />
    ),
    size: 90,
  },
  {
    accessorKey: "sourceQuote",
    header: "Source Quote",
    cell: ({ row }) => {
      const quote = row.original.sourceQuote;
      if (!quote) return <span className="text-muted-foreground">-</span>;
      return (
        <span
          className="text-xs text-muted-foreground italic"
          title={quote}
        >
          &ldquo;
          {quote.length > 80 ? quote.slice(0, 80) + "..." : quote}
          &rdquo;
        </span>
      );
    },
    size: 200,
  },
  {
    id: "relatedEntities",
    header: "Related",
    cell: ({ row }) => {
      const entities = row.original.relatedEntities;
      if (!entities || entities.length === 0)
        return <span className="text-muted-foreground text-[10px]">-</span>;
      return (
        <div className="flex flex-wrap gap-0.5">
          {entities.slice(0, 3).map((eid) => (
            <Link
              key={eid}
              href={`/claims/entity/${eid}`}
              className="inline-block px-1 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 hover:bg-gray-200"
            >
              {eid}
            </Link>
          ))}
          {entities.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{entities.length - 3}
            </span>
          )}
        </div>
      );
    },
    size: 120,
  },
];

export function ClaimsTable({
  claims,
  pageSize = 30,
}: {
  claims: ClaimRow[];
  pageSize?: number;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const table = useReactTable({
    data: claims,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    getRowCanExpand: () => true,
  });

  return (
    <div>
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
                <Fragment key={row.id}>
                  <TableRow
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
                  {row.getIsExpanded() && (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="p-0">
                        <ExpandedClaimDetail claim={row.original} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No claims found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-2 py-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {claims.length} claims
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
