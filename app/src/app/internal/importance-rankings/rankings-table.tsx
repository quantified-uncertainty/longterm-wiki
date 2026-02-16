"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { PageRankingItem } from "@/data";

function RankWithScore({
  rank,
  score,
  thresholds,
}: {
  rank: number | null;
  score: number | null;
  thresholds: [number, string][];
}) {
  if (rank == null || score == null)
    return <span className="text-muted-foreground/40">-</span>;
  const color =
    thresholds.find(([t]) => score >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs tabular-nums font-semibold text-foreground">
        #{rank}
      </span>
      <span className={`text-[11px] tabular-nums ${color}`}>
        ({Math.round(score)})
      </span>
    </span>
  );
}

const readerThresholds: [number, string][] = [
  [90, "text-purple-500"],
  [70, "text-violet-500"],
  [50, "text-indigo-500"],
  [30, "text-slate-400"],
  [0, "text-slate-400/60"],
];

const researchThresholds: [number, string][] = [
  [90, "text-orange-500"],
  [70, "text-amber-500"],
  [50, "text-yellow-600"],
  [30, "text-slate-400"],
  [0, "text-slate-400/60"],
];

const qualityThresholds: [number, string][] = [
  [80, "text-emerald-500"],
  [60, "text-blue-500"],
  [40, "text-amber-500"],
  [20, "text-red-500"],
  [0, "text-slate-400/60"],
];

function ScoreBadge({
  value,
  thresholds,
}: {
  value: number | null;
  thresholds: [number, string][];
}) {
  if (value == null) return <span className="text-muted-foreground/40">-</span>;
  const color =
    thresholds.find(([t]) => value >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(value)}
    </span>
  );
}

const columns: ColumnDef<PageRankingItem>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.numericId}`}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "readerRank",
    sortUndefined: "last",
    header: ({ column }) => (
      <SortableHeader column={column}>Readership</SortableHeader>
    ),
    cell: ({ row }) => (
      <RankWithScore
        rank={row.original.readerRank}
        score={row.original.readerImportance}
        thresholds={readerThresholds}
      />
    ),
  },
  {
    accessorKey: "researchRank",
    sortUndefined: "last",
    header: ({ column }) => (
      <SortableHeader column={column}>Research</SortableHeader>
    ),
    cell: ({ row }) => (
      <RankWithScore
        rank={row.original.researchRank}
        score={row.original.researchImportance}
        thresholds={researchThresholds}
      />
    ),
  },
  {
    accessorKey: "quality",
    header: ({ column }) => (
      <SortableHeader column={column}>Quality</SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreBadge
        value={row.original.quality}
        thresholds={qualityThresholds}
      />
    ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.category}
      </span>
    ),
  },
  {
    accessorKey: "wordCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Words</SortableHeader>
    ),
    cell: ({ row }) => {
      const wc = row.original.wordCount;
      return (
        <span className="text-xs tabular-nums text-muted-foreground">
          {wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}
        </span>
      );
    },
  },
];

export function RankingsTable({ data }: { data: PageRankingItem[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search pages..."
      defaultSorting={[{ id: "readerRank", desc: false }]}
    />
  );
}
