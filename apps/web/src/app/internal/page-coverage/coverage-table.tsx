"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { PageCoverageItem } from "@/data";

type Status = "green" | "amber" | "red";

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "green"
      ? "bg-emerald-500"
      : status === "amber"
        ? "bg-amber-500"
        : "bg-red-400/60";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function BoolIcon({ value }: { value: boolean }) {
  return value ? (
    <span className="text-emerald-500 text-xs font-bold">✓</span>
  ) : (
    <span className="text-muted-foreground/30 text-xs">✗</span>
  );
}

function ScoreBadge({ score, total }: { score: number; total: number }) {
  const pct = score / total;
  const color =
    pct >= 0.75
      ? "bg-emerald-500/15 text-emerald-600"
      : pct >= 0.5
        ? "bg-amber-500/15 text-amber-600"
        : "bg-red-500/15 text-red-600";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] tabular-nums font-bold ${color}`}
    >
      {score}/{total}
    </span>
  );
}

const qualityThresholds: [number, string][] = [
  [80, "text-emerald-500"],
  [60, "text-blue-500"],
  [40, "text-amber-500"],
  [20, "text-red-500"],
  [0, "text-slate-400/60"],
];

function ScoreValue({
  value,
  thresholds,
}: {
  value: number | null;
  thresholds: [number, string][];
}) {
  if (value == null)
    return <span className="text-muted-foreground/40">-</span>;
  const color =
    thresholds.find(([t]) => value >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(value)}
    </span>
  );
}

const columns: ColumnDef<PageCoverageItem>[] = [
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
    accessorKey: "score",
    header: ({ column }) => (
      <SortableHeader column={column}>Score</SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreBadge score={row.original.score} total={row.original.total} />
    ),
  },
  {
    accessorKey: "quality",
    header: ({ column }) => (
      <SortableHeader column={column}>Quality</SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreValue
        value={row.original.quality}
        thresholds={qualityThresholds}
      />
    ),
  },
  {
    accessorKey: "readerImportance",
    sortUndefined: "last",
    header: ({ column }) => (
      <SortableHeader column={column}>Importance</SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreValue
        value={row.original.readerImportance}
        thresholds={qualityThresholds}
      />
    ),
  },
  {
    accessorKey: "contentFormat",
    header: ({ column }) => (
      <SortableHeader column={column}>Format</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.contentFormat}
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
  {
    id: "booleans",
    header: "Bool",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1">
        <BoolIcon value={row.original.llmSummary} />
        <BoolIcon value={row.original.structuredSummary} />
        <BoolIcon value={row.original.schedule} />
        <BoolIcon value={row.original.entity} />
        <BoolIcon value={row.original.editHistory} />
      </span>
    ),
  },
  {
    id: "tables",
    accessorKey: "tables",
    header: ({ column }) => (
      <SortableHeader column={column}>Tbl</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.tables} />,
    sortingFn: (a, b) => statusOrder(a.original.tables) - statusOrder(b.original.tables),
  },
  {
    id: "diagrams",
    accessorKey: "diagrams",
    header: ({ column }) => (
      <SortableHeader column={column}>Dia</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.diagrams} />,
    sortingFn: (a, b) => statusOrder(a.original.diagrams) - statusOrder(b.original.diagrams),
  },
  {
    id: "internalLinks",
    accessorKey: "internalLinks",
    header: ({ column }) => (
      <SortableHeader column={column}>Int</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.internalLinks} />,
    sortingFn: (a, b) => statusOrder(a.original.internalLinks) - statusOrder(b.original.internalLinks),
  },
  {
    id: "externalLinks",
    accessorKey: "externalLinks",
    header: ({ column }) => (
      <SortableHeader column={column}>Ext</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.externalLinks} />,
    sortingFn: (a, b) => statusOrder(a.original.externalLinks) - statusOrder(b.original.externalLinks),
  },
  {
    id: "footnotes",
    accessorKey: "footnotes",
    header: ({ column }) => (
      <SortableHeader column={column}>Fn</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.footnotes} />,
    sortingFn: (a, b) => statusOrder(a.original.footnotes) - statusOrder(b.original.footnotes),
  },
  {
    id: "references",
    accessorKey: "references",
    header: ({ column }) => (
      <SortableHeader column={column}>Ref</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.references} />,
    sortingFn: (a, b) => statusOrder(a.original.references) - statusOrder(b.original.references),
  },
  {
    id: "quotes",
    accessorKey: "quotes",
    header: ({ column }) => (
      <SortableHeader column={column}>Qt</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.quotes} />,
    sortingFn: (a, b) => statusOrder(a.original.quotes) - statusOrder(b.original.quotes),
  },
  {
    id: "accuracy",
    accessorKey: "accuracy",
    header: ({ column }) => (
      <SortableHeader column={column}>Acc</SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.accuracy} />,
    sortingFn: (a, b) => statusOrder(a.original.accuracy) - statusOrder(b.original.accuracy),
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
];

function statusOrder(s: Status): number {
  return s === "red" ? 0 : s === "amber" ? 1 : 2;
}

export function CoverageTable({ data }: { data: PageCoverageItem[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search pages..."
      defaultSorting={[{ id: "score", desc: false }]}
    />
  );
}
