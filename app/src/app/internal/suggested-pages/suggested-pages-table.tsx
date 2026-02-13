"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";

export interface SuggestedPage {
  rank: number;
  title: string;
  type: string;
  tier: "Critical" | "High" | "Important";
  reason: string;
  relatedPages: { id: string; title: string }[];
  command: string;
}

function TierBadge({ tier }: { tier: SuggestedPage["tier"] }) {
  const styles = {
    Critical:
      "bg-red-500/15 text-red-500",
    High:
      "bg-amber-500/15 text-amber-500",
    Important:
      "bg-blue-500/15 text-blue-500",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[tier]}`}
    >
      {tier}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
      {type}
    </span>
  );
}

const tierOrder = { Critical: 0, High: 1, Important: 2 };

const columns: ColumnDef<SuggestedPage>[] = [
  {
    accessorKey: "rank",
    header: ({ column }) => (
      <SortableHeader column={column}>#</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.rank}
      </span>
    ),
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Suggested Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm font-medium">{row.original.title}</span>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => <TypeBadge type={row.original.type} />,
  },
  {
    accessorKey: "tier",
    header: ({ column }) => (
      <SortableHeader column={column}>Tier</SortableHeader>
    ),
    cell: ({ row }) => <TierBadge tier={row.original.tier} />,
    sortingFn: (rowA, rowB) =>
      tierOrder[rowA.original.tier] - tierOrder[rowB.original.tier],
  },
  {
    accessorKey: "reason",
    header: "Why It's Needed",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground leading-relaxed">
        {row.original.reason}
      </span>
    ),
    enableSorting: false,
  },
  {
    id: "related",
    header: "Related Pages",
    cell: ({ row }) => {
      const pages = row.original.relatedPages;
      if (pages.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <a
              key={p.id}
              href={`/wiki/${p.id}`}
              className="text-[11px] text-accent-foreground hover:underline no-underline"
            >
              {p.title}
            </a>
          ))}
        </div>
      );
    },
    enableSorting: false,
  },
];

export function SuggestedPagesTable({ data }: { data: SuggestedPage[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search suggested pages..."
      defaultSorting={[{ id: "rank", desc: false }]}
    />
  );
}
