"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import type { ExploreItem } from "@/data";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { getTypeLabel, getTypeColor, formatWordCount } from "./explore-utils";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ScoreBadge({ value, max = 100 }: { value: number | null; max?: number }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const pct = value / max;
  const color =
    pct >= 0.7
      ? "text-emerald-600 dark:text-emerald-400"
      : pct >= 0.4
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500 dark:text-red-400";
  return <span className={`font-medium tabular-nums ${color}`}>{value}</span>;
}

const columns: ColumnDef<ExploreItem>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => {
      const item = row.original;
      const href = item.href || `/wiki/${item.numericId}`;
      return (
        <Link
          href={href}
          className="font-medium text-foreground hover:text-accent-foreground hover:underline transition-colors"
        >
          {item.title}
        </Link>
      );
    },
    size: 280,
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => {
      const type = row.original.type;
      return (
        <span className={`text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap ${getTypeColor(type)}`}>
          {getTypeLabel(type)}
        </span>
      );
    },
    size: 120,
  },
  {
    accessorKey: "readerImportance",
    header: ({ column }) => (
      <SortableHeader column={column}>Importance</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.readerImportance} />,
    size: 100,
    sortUndefined: "last",
  },
  {
    accessorKey: "quality",
    header: ({ column }) => (
      <SortableHeader column={column}>Quality</SortableHeader>
    ),
    cell: ({ row }) => <ScoreBadge value={row.original.quality} />,
    size: 90,
    sortUndefined: "last",
  },
  {
    accessorKey: "wordCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Words</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground tabular-nums text-sm">
        {row.original.wordCount ? formatWordCount(row.original.wordCount) : "—"}
      </span>
    ),
    size: 100,
    sortUndefined: "last",
  },
  {
    accessorKey: "lastUpdated",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Updated</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm whitespace-nowrap">
        {formatDate(row.original.lastUpdated)}
      </span>
    ),
    size: 130,
    sortUndefined: "last",
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm capitalize">
        {row.original.category || "—"}
      </span>
    ),
    size: 120,
    sortUndefined: "last",
  },
  {
    id: "tags",
    header: "Tags",
    cell: ({ row }) => {
      const tags = row.original.tags;
      if (!tags.length) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[0.65rem] px-1.5 py-0.5 bg-muted rounded text-muted-foreground whitespace-nowrap"
            >
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-[0.65rem] text-muted-foreground">
              +{tags.length - 3}
            </span>
          )}
        </div>
      );
    },
    size: 200,
  },
  {
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => {
      const desc = row.original.description;
      if (!desc || desc === row.original.title) {
        return <span className="text-muted-foreground">—</span>;
      }
      const truncated = desc.length > 120 ? desc.slice(0, 117) + "..." : desc;
      return (
        <span className="text-muted-foreground text-sm leading-snug">
          {truncated}
        </span>
      );
    },
    size: 300,
  },
];

export function ExploreTable({ items }: { items: ExploreItem[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "readerImportance", desc: true },
  ]);

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable
      table={table}
      stickyFirstColumn
    />
  );
}
