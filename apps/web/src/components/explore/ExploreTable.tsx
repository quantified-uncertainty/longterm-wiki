"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
} from "@tanstack/react-table";
import type { ExploreItem } from "@/data";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { getTypeLabel, getTypeColor } from "./explore-utils";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWordCountCompact(count: number | null): string {
  if (count == null) return "—";
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return `${count}`;
}

function ScoreBadge({ value, max = 100 }: { value: number | null; max?: number }) {
  if (value == null) return <span className="text-muted-foreground/50">—</span>;
  const pct = Math.max(0, Math.min(value, max)) / max;
  const color =
    pct >= 0.7
      ? "text-emerald-600 dark:text-emerald-400"
      : pct >= 0.4
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500 dark:text-red-400";
  return <span className={`font-medium tabular-nums ${color}`}>{value}</span>;
}

function ClickableTag({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[0.6rem] leading-none px-1.5 py-0.5 bg-muted rounded text-muted-foreground whitespace-nowrap hover:bg-foreground/10 hover:text-foreground transition-colors cursor-pointer"
    >
      {label}
    </button>
  );
}

function buildColumns(onSearchChange: (value: string) => void): ColumnDef<ExploreItem>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => <SortableHeader column={column}>Title</SortableHeader>,
      cell: ({ row }) => {
        const item = row.original;
        const href = item.href || `/wiki/${item.numericId}`;
        return (
          <Link
            href={href}
            className="font-medium text-foreground hover:text-accent-foreground hover:underline transition-colors text-[13px]"
          >
            {item.title}
          </Link>
        );
      },
      size: 240,
    },
    {
      accessorKey: "type",
      header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
      cell: ({ row }) => (
        <span className={`text-[0.6rem] leading-none font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${getTypeColor(row.original.type)}`}>
          {getTypeLabel(row.original.type)}
        </span>
      ),
      size: 100,
    },
    {
      accessorKey: "readerImportance",
      header: ({ column }) => <SortableHeader column={column} title="Reader importance (0–100)">Imp.</SortableHeader>,
      cell: ({ row }) => <ScoreBadge value={row.original.readerImportance} />,
      size: 60,
      sortUndefined: "last",
    },
    {
      accessorKey: "researchImportance",
      header: ({ column }) => <SortableHeader column={column} title="Research importance (0–100)">Res.</SortableHeader>,
      cell: ({ row }) => <ScoreBadge value={row.original.researchImportance} />,
      size: 60,
      sortUndefined: "last",
    },
    {
      accessorKey: "tacticalValue",
      header: ({ column }) => <SortableHeader column={column} title="Tactical value — how time-sensitive / news-relevant (0–100)">Tact.</SortableHeader>,
      cell: ({ row }) => <ScoreBadge value={row.original.tacticalValue} />,
      size: 60,
      sortUndefined: "last",
    },
    {
      accessorKey: "quality",
      header: ({ column }) => <SortableHeader column={column} title="Page quality score (0–100)">Qual.</SortableHeader>,
      cell: ({ row }) => <ScoreBadge value={row.original.quality} />,
      size: 60,
      sortUndefined: "last",
    },
    {
      accessorKey: "backlinkCount",
      header: ({ column }) => <SortableHeader column={column} title="Pages linking to this one">Links</SortableHeader>,
      cell: ({ row }) => {
        const count = row.original.backlinkCount;
        if (count == null || count === 0) return <span className="text-muted-foreground/50">—</span>;
        return <span className="text-muted-foreground tabular-nums text-xs">{count}</span>;
      },
      size: 55,
      sortUndefined: "last",
    },
    {
      accessorKey: "wordCount",
      header: ({ column }) => <SortableHeader column={column}>Words</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums text-xs">
          {formatWordCountCompact(row.original.wordCount)}
        </span>
      ),
      size: 60,
      sortUndefined: "last",
    },
    {
      accessorKey: "lastUpdated",
      header: ({ column }) => <SortableHeader column={column}>Updated</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {formatDate(row.original.lastUpdated)}
        </span>
      ),
      size: 110,
      sortUndefined: "last",
    },
    {
      accessorKey: "dateCreated",
      header: ({ column }) => <SortableHeader column={column}>Created</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {formatDate(row.original.dateCreated ?? null)}
        </span>
      ),
      size: 110,
      sortUndefined: "last",
    },
    {
      accessorKey: "category",
      header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
      cell: ({ row }) => {
        const cat = row.original.category;
        if (!cat) return <span className="text-muted-foreground/50">—</span>;
        return (
          <button
            type="button"
            onClick={() => onSearchChange(cat)}
            className="text-xs capitalize text-muted-foreground hover:text-foreground hover:underline transition-colors cursor-pointer"
          >
            {cat}
          </button>
        );
      },
      size: 100,
      sortUndefined: "last",
    },
    {
      accessorKey: "numericId",
      header: ({ column }) => <SortableHeader column={column}>ID</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-[0.65rem] text-muted-foreground/60 tabular-nums">
          {row.original.numericId}
        </span>
      ),
      size: 55,
    },
    {
      id: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (!tags.length) return <span className="text-muted-foreground/50">—</span>;
        return (
          <div className="flex flex-wrap gap-0.5">
            {tags.slice(0, 3).map((tag) => (
              <ClickableTag key={tag} label={tag} onClick={() => onSearchChange(tag)} />
            ))}
            {tags.length > 3 && (
              <span className="text-[0.6rem] text-muted-foreground/60">+{tags.length - 3}</span>
            )}
          </div>
        );
      },
      size: 180,
    },
  ];
}

export function ExploreTable({
  items,
  onSearchChange,
}: {
  items: ExploreItem[];
  onSearchChange: (value: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "readerImportance", desc: true },
  ]);

  const columns = useMemo(() => buildColumns(onSearchChange), [onSearchChange]);

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
      containerClassName="rounded-lg border border-border/60 shadow-sm max-h-[calc(100vh-13rem)] overflow-auto"
    />
  );
}
