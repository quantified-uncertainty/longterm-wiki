"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { InsightItem } from "@/data";

const TYPE_LABELS: Record<string, string> = {
  claim: "Claim",
  "research-gap": "Research Gap",
  counterintuitive: "Counterintuitive",
  quantitative: "Quantitative",
  disagreement: "Disagreement",
  neglected: "Neglected",
};

const TYPE_COLORS: Record<string, string> = {
  claim: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "research-gap": "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  counterintuitive: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  quantitative: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  disagreement: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  neglected: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
};

function ScoreBadge({ value }: { value: number }) {
  const color =
    value >= 4
      ? "text-emerald-600 dark:text-emerald-400 font-semibold"
      : value >= 3
        ? "text-amber-600 dark:text-amber-400 font-medium"
        : "text-muted-foreground";
  return <span className={`text-xs tabular-nums ${color}`}>{value.toFixed(1)}</span>;
}

const columns: ColumnDef<InsightItem>[] = [
  {
    accessorKey: "insight",
    header: ({ column }) => (
      <SortableHeader column={column}>Insight</SortableHeader>
    ),
    cell: ({ row }) => {
      const item = row.original;
      return (
        <div className="min-w-[280px] max-w-[480px]">
          <p className="text-sm leading-relaxed">{item.insight}</p>
          {item.sourceTitle && (
            <Link
              href={item.sourceHref}
              className="text-[11px] text-muted-foreground hover:text-foreground no-underline mt-1 block"
            >
              → {item.sourceTitle}
            </Link>
          )}
        </div>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => {
      const type = row.original.type;
      return (
        <span
          className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${TYPE_COLORS[type] || ""}`}
        >
          {TYPE_LABELS[type] || type}
        </span>
      );
    },
  },
  {
    accessorKey: "composite",
    header: ({ column }) => (
      <SortableHeader column={column}>Composite</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.composite} />,
  },
  {
    accessorKey: "surprising",
    header: ({ column }) => (
      <SortableHeader column={column}>Surprising</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.surprising} />,
  },
  {
    accessorKey: "important",
    header: ({ column }) => (
      <SortableHeader column={column}>Important</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.important} />,
  },
  {
    accessorKey: "actionable",
    header: ({ column }) => (
      <SortableHeader column={column}>Actionable</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.actionable} />,
  },
  {
    accessorKey: "neglected",
    header: ({ column }) => (
      <SortableHeader column={column}>Neglected</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.neglected} />,
  },
  {
    accessorKey: "compact",
    header: ({ column }) => (
      <SortableHeader column={column}>Compact</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.compact} />,
  },
  {
    accessorKey: "tags",
    header: () => <span className="text-xs">Tags</span>,
    cell: ({ row }) => {
      const tags = row.original.tags;
      if (!tags.length) return null;
      return (
        <div className="flex flex-wrap gap-1 min-w-[100px]">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[9px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded"
            >
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-[9px] text-muted-foreground">
              +{tags.length - 3}
            </span>
          )}
        </div>
      );
    },
    enableSorting: false,
  },
];

export function InsightsTable({ data }: { data: InsightItem[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search insights..."
      defaultSorting={[{ id: "composite", desc: true }]}
    />
  );
}
