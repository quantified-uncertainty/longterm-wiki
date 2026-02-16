"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import {
  priorityBadge,
  categoryBadge,
  coverageColor,
  itnLabel,
} from "@/components/wiki/badge-styles";
import { cn } from "@lib/utils";

export interface InterventionRow {
  id: string;
  name: string;
  category: string;
  description: string;
  overallPriority: string;
  timelineFit: string;
  tractability: string;
  neglectedness: string;
  importance: string;
  fundingLevel: string;
  fundingShare: string;
  recommendedShift: string;
  riskCoverage: {
    accident: string;
    misuse: string;
    structural: string;
    epistemic: string;
  };
  primaryMechanism: string;
  currentState: string;
  wikiPageHref: string | null;
  relatedInterventions: string[];
  relevantResearch: Array<{ title: string; url?: string }>;
}

function CoverageDot({ level }: { level: string }) {
  return (
    <span
      className={cn("text-[11px]", coverageColor[level] || coverageColor.none)}
      title={level}
    >
      {level === "none" ? "\u2014" : level}
    </span>
  );
}

const columns: ColumnDef<InterventionRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Intervention</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="min-w-[160px]">
        {row.original.wikiPageHref ? (
          <Link
            href={row.original.wikiPageHref}
            className="text-sm font-medium text-accent-foreground hover:underline no-underline"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="text-sm font-medium">{row.original.name}</span>
        )}
        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed max-w-[280px]">
          {row.original.description}
        </p>
      </div>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => {
      const cat = row.original.category;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            categoryBadge[cat] || categoryBadge.technical
          )}
        >
          {cat}
        </span>
      );
    },
  },
  {
    accessorKey: "overallPriority",
    header: ({ column }) => (
      <SortableHeader column={column}>Priority</SortableHeader>
    ),
    cell: ({ row }) => {
      const p = row.original.overallPriority;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            priorityBadge[p] || priorityBadge.Medium
          )}
        >
          {p}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const order: Record<string, number> = {
        "Very High": 4,
        High: 3,
        "Medium-High": 2,
        Medium: 1,
      };
      return (
        (order[a.original.overallPriority] || 0) -
        (order[b.original.overallPriority] || 0)
      );
    },
  },
  {
    accessorKey: "timelineFit",
    header: ({ column }) => (
      <SortableHeader column={column}>Timeline</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {row.original.timelineFit}
      </span>
    ),
  },
  {
    id: "itn",
    header: "ITN",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground whitespace-nowrap">
        <span>
          T: <strong>{itnLabel[row.original.tractability] || row.original.tractability}</strong>
        </span>
        <span>
          I: <strong>{itnLabel[row.original.importance] || row.original.importance}</strong>
        </span>
        <span>
          N: <strong>{itnLabel[row.original.neglectedness] || row.original.neglectedness}</strong>
        </span>
      </div>
    ),
  },
  {
    id: "riskCoverage",
    header: "Risk Coverage",
    cell: ({ row }) => {
      const rc = row.original.riskCoverage;
      return (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] min-w-[120px]">
          <span className="text-muted-foreground">Acc:</span>
          <CoverageDot level={rc.accident} />
          <span className="text-muted-foreground">Mis:</span>
          <CoverageDot level={rc.misuse} />
          <span className="text-muted-foreground">Str:</span>
          <CoverageDot level={rc.structural} />
          <span className="text-muted-foreground">Epi:</span>
          <CoverageDot level={rc.epistemic} />
        </div>
      );
    },
  },
  {
    id: "funding",
    header: "Funding",
    cell: ({ row }) => (
      <div className="text-[11px] text-muted-foreground whitespace-nowrap">
        {row.original.fundingLevel && <div>{row.original.fundingLevel}</div>}
        {row.original.fundingShare && (
          <div className="text-muted-foreground/70">
            {row.original.fundingShare} of portfolio
          </div>
        )}
        {row.original.recommendedShift && (
          <div className="font-medium text-foreground">
            {row.original.recommendedShift}
          </div>
        )}
      </div>
    ),
  },
];

export function InterventionsTable({ data }: { data: InterventionRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search interventions..."
      defaultSorting={[{ id: "overallPriority", desc: true }]}
    />
  );
}
