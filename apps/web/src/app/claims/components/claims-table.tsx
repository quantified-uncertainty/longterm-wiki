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
import { ClaimModeBadge } from "./claim-mode-badge";
import { NumericValueDisplay } from "./numeric-value-display";
import { VerdictBadge } from "./verdict-badge";

function ExpandedClaimDetail({ claim, entityNames = {} }: { claim: ClaimRow; entityNames?: Record<string, string> }) {
  return (
    <div className="px-4 py-3 space-y-2 text-sm">
      <div>
        <span className="font-medium text-xs text-muted-foreground">
          Full Claim:
        </span>
        <p className="mt-0.5">{claim.claimText}</p>
      </div>

      {/* Epistemic mode — show badge for attributed; always show asOf when set */}
      {(claim.claimMode === "attributed" || claim.asOf) && (
        <div className="flex items-center gap-2">
          {claim.claimMode === "attributed" && (
            <ClaimModeBadge mode={claim.claimMode} attributedTo={claim.attributedTo} />
          )}
          {claim.asOf && (
            <span className="text-[10px] text-muted-foreground">as of {claim.asOf}</span>
          )}
        </div>
      )}

      {/* Numeric value — show if any numeric field is present (central, low, or high) */}
      {(claim.valueNumeric != null || claim.valueLow != null || claim.valueHigh != null) && (
        <NumericValueDisplay
          value={claim.valueNumeric}
          low={claim.valueLow}
          high={claim.valueHigh}
          measure={claim.measure}
        />
      )}

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

      {/* Verdict details */}
      {claim.claimVerdict && (
        <div>
          <span className="font-medium text-xs text-muted-foreground block mb-1">
            Verdict:
          </span>
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={claim.claimVerdict} score={claim.claimVerdictScore} />
            {claim.claimVerdictDifficulty && (
              <span className="text-[10px] text-muted-foreground">
                Difficulty: {claim.claimVerdictDifficulty}
              </span>
            )}
          </div>
          {claim.claimVerdictIssues && (
            <p className="mt-1 text-xs text-muted-foreground">{claim.claimVerdictIssues}</p>
          )}
        </div>
      )}

      {/* Structured claim fields */}
      {claim.property && (
        <div>
          <span className="font-medium text-xs text-muted-foreground block mb-1">
            Structured Data:
          </span>
          <div className="flex flex-wrap gap-2 text-xs">
            {claim.subjectEntity && (
              <span>
                <span className="text-muted-foreground">Subject:</span>{" "}
                <span className="font-mono">{claim.subjectEntity}</span>
              </span>
            )}
            <span>
              <span className="text-muted-foreground">Property:</span>{" "}
              <span className="font-mono">{claim.property}</span>
            </span>
            {claim.structuredValue && (
              <span>
                <span className="text-muted-foreground">Value:</span>{" "}
                <span className="font-mono">{claim.structuredValue}</span>
              </span>
            )}
            {claim.valueUnit && (
              <span>
                <span className="text-muted-foreground">Unit:</span>{" "}
                <span className="font-mono">{claim.valueUnit}</span>
              </span>
            )}
            {claim.valueDate && (
              <span>
                <span className="text-muted-foreground">Date:</span>{" "}
                <span className="font-mono">{claim.valueDate}</span>
              </span>
            )}
            {claim.qualifiers && Object.keys(claim.qualifiers).length > 0 && (
              <span>
                <span className="text-muted-foreground">Qualifiers:</span>{" "}
                {Object.entries(claim.qualifiers).map(([k, v]) => (
                  <span key={k} className="font-mono ml-1">
                    {k}={v}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      {/* claim_sources */}
      {claim.sources && claim.sources.length > 0 && (
        <div>
          <span className="font-medium text-xs text-muted-foreground block mb-1">
            Sources ({claim.sources.length}):
          </span>
          <div className="space-y-1">
            {claim.sources.map((s) => (
              <div key={s.id} className="text-xs flex items-start gap-2">
                {s.isPrimary && (
                  <span className="bg-blue-100 text-blue-700 px-1 py-0.5 rounded text-[9px] shrink-0">
                    primary
                  </span>
                )}
                {s.resourceId ? (
                  <Link
                    href={`/source/${s.resourceId}`}
                    className="text-blue-600 hover:underline font-mono"
                  >
                    {s.resourceId}
                  </Link>
                ) : s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline truncate"
                  >
                    {s.url}
                  </a>
                ) : null}
                {s.sourceQuote && (
                  <span className="italic text-muted-foreground truncate">
                    &ldquo;{s.sourceQuote.slice(0, 80)}&rdquo;
                  </span>
                )}
              </div>
            ))}
          </div>
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
                href={`/claims/entity/${eid.toLowerCase()}`}
                className="text-blue-600 hover:underline ml-1"
              >
                {entityNames[eid.toLowerCase()] ?? eid}
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

function getColumns(entityNames: Record<string, string>): ColumnDef<ClaimRow>[] {
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
          <ChevronRightIcon className="h-3.5 w-3.5" />
        )}
      </button>
    ),
    size: 30,
  },
  {
    id: "claimId",
    header: "#",
    cell: ({ row }) => (
      <Link
        href={`/claims/claim/${row.original.id}`}
        className="font-mono text-xs text-blue-600 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.original.id}
      </Link>
    ),
    size: 40,
  },
  {
    accessorKey: "entityId",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/claims/entity/${row.original.entityId}`}
        className="text-blue-600 hover:underline text-xs"
      >
        {entityNames[row.original.entityId] ?? row.original.entityId}
      </Link>
    ),
    size: 120,
  },
  {
    accessorKey: "claimText",
    header: "Claim",
    cell: ({ row }) => {
      const c = row.original;
      const hasNumeric = c.valueNumeric != null || c.valueLow != null || c.valueHigh != null;
      return (
        <div className="space-y-0.5">
          <span
            className="text-xs leading-relaxed"
            title={c.claimText}
          >
            {c.claimText.length > 200
              ? c.claimText.slice(0, 200) + "..."
              : c.claimText}
          </span>
          {hasNumeric && (
            <div>
              <NumericValueDisplay
                value={c.valueNumeric}
                low={c.valueLow}
                high={c.valueHigh}
                measure={c.measure}
                compact
              />
            </div>
          )}
        </div>
      );
    },
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
    id: "sources",
    accessorFn: (row) => row.sources?.length ?? 0,
    header: ({ column }) => (
      <SortableHeader column={column}>Src</SortableHeader>
    ),
    cell: ({ row }) => {
      const count = row.original.sources?.length ?? 0;
      if (count === 0) return <span className="text-muted-foreground/40 text-xs">—</span>;
      return (
        <span
          className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded text-[10px] font-medium ${
            count >= 3
              ? "bg-emerald-100 text-emerald-700"
              : count >= 1
                ? "bg-blue-100 text-blue-700"
                : ""
          }`}
        >
          {count}
        </span>
      );
    },
    size: 45,
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
    id: "claimMode",
    header: "Mode",
    cell: ({ row }) => (
      <div className="space-y-1">
        <ClaimModeBadge
          mode={row.original.claimMode}
          attributedTo={row.original.attributedTo}
          compact
        />
        {row.original.asOf && (
          <div className="text-[9px] text-muted-foreground">{row.original.asOf}</div>
        )}
      </div>
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
    id: "verdict",
    accessorFn: (row) => row.claimVerdict,
    header: ({ column }) => (
      <SortableHeader column={column}>Verdict</SortableHeader>
    ),
    cell: ({ row }) => (
      <VerdictBadge
        verdict={row.original.claimVerdict}
        score={row.original.claimVerdictScore}
      />
    ),
    size: 100,
  },
  {
    id: "structured",
    accessorFn: (row) => row.property,
    header: ({ column }) => (
      <SortableHeader column={column}>Structured</SortableHeader>
    ),
    cell: ({ row }) => {
      const c = row.original;
      if (!c.property) return <span className="text-muted-foreground/40 text-xs">&mdash;</span>;
      const parts: string[] = [c.property];
      if (c.structuredValue) {
        parts.push(`= ${c.structuredValue}`);
      }
      if (c.valueUnit) {
        parts.push(`[${c.valueUnit}]`);
      }
      return (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-violet-100 text-violet-700 max-w-[180px] truncate"
          title={`${c.property}${c.structuredValue ? ` = ${c.structuredValue}` : ""}${c.valueUnit ? ` [${c.valueUnit}]` : ""}${c.valueDate ? ` @ ${c.valueDate}` : ""}`}
        >
          {parts.join(" ")}
        </span>
      );
    },
    size: 160,
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
              href={`/claims/entity/${eid.toLowerCase()}`}
              className="inline-block px-1 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 hover:bg-gray-200"
            >
              {entityNames[eid.toLowerCase()] ?? eid}
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
}

export function ClaimsTable({
  claims,
  pageSize = 30,
  entityNames = {},
}: {
  claims: ClaimRow[];
  pageSize?: number;
  entityNames?: Record<string, string>;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const columns = getColumns(entityNames);

  const table = useReactTable({
    data: claims,
    columns: columns,
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
                      <TableCell colSpan={columns.length} className="p-0 bg-muted/30">
                        <ExpandedClaimDetail claim={row.original} entityNames={entityNames} />
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
