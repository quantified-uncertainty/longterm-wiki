"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import {
  domainBadge,
  stanceBadge,
  feasibilityColor,
  statusLabel,
} from "@/components/wiki/badge-styles";
import { cn } from "@lib/utils";

export interface ProposalRow {
  id: string;
  name: string;
  description: string;
  domain: string;
  stance: string;
  costEstimate: string;
  evEstimate: string;
  feasibility: string;
  honestConcerns: string;
  status: string;
  sourcePageHref: string | null;
  sourcePageId: string;
  leadOrganizations: string[];
  relatedProposals: string[];
}

const columns: ColumnDef<ProposalRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Proposal</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="min-w-[180px]">
        <span className="text-sm font-medium">{row.original.name}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed max-w-[300px]">
          {row.original.description}
        </p>
      </div>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "domain",
    header: ({ column }) => (
      <SortableHeader column={column}>Domain</SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.domain;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            domainBadge[d] || domainBadge.governance
          )}
        >
          {d}
        </span>
      );
    },
  },
  {
    accessorKey: "stance",
    header: ({ column }) => (
      <SortableHeader column={column}>Stance</SortableHeader>
    ),
    cell: ({ row }) => {
      const s = row.original.stance;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            stanceBadge[s] || stanceBadge.neutral
          )}
        >
          {s}
        </span>
      );
    },
  },
  {
    accessorKey: "feasibility",
    header: ({ column }) => (
      <SortableHeader column={column}>Feasibility</SortableHeader>
    ),
    cell: ({ row }) => {
      const f = row.original.feasibility;
      return (
        <span
          className={cn(
            "text-xs font-medium whitespace-nowrap",
            feasibilityColor[f] || ""
          )}
        >
          {f}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
      return (
        (order[a.original.feasibility] || 0) -
        (order[b.original.feasibility] || 0)
      );
    },
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {statusLabel[row.original.status] || row.original.status}
      </span>
    ),
  },
  {
    id: "economics",
    header: "Cost / EV",
    cell: ({ row }) => (
      <div className="text-[11px] text-muted-foreground whitespace-nowrap">
        {row.original.costEstimate && (
          <div>
            Cost: <strong>{row.original.costEstimate}</strong>
          </div>
        )}
        {row.original.evEstimate && (
          <div>
            EV: <strong>{row.original.evEstimate}</strong>
          </div>
        )}
      </div>
    ),
  },
  {
    accessorKey: "sourcePageId",
    header: "Source",
    cell: ({ row }) =>
      row.original.sourcePageHref ? (
        <Link
          href={row.original.sourcePageHref}
          className="text-[11px] text-accent-foreground hover:underline no-underline whitespace-nowrap"
        >
          {row.original.sourcePageId}
        </Link>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          {row.original.sourcePageId}
        </span>
      ),
  },
  {
    id: "leadOrgs",
    header: "Lead Orgs",
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1 max-w-[160px]">
        {row.original.leadOrganizations.map((org) => (
          <span
            key={org}
            className="text-[10px] bg-muted rounded px-1.5 py-0.5"
          >
            {org}
          </span>
        ))}
      </div>
    ),
  },
];

export function ProposalsTable({ data }: { data: ProposalRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search proposals..."
      defaultSorting={[{ id: "feasibility", desc: true }]}
    />
  );
}
