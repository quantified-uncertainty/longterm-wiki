"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { RiskPageData } from "./page";

function LevelBadge({ level }: { level: "low" | "medium" | "high" }) {
  const config = {
    high: "bg-red-500/15 text-red-500",
    medium: "bg-amber-500/15 text-amber-500",
    low: "bg-emerald-500/15 text-emerald-500",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${config[level]}`}
    >
      {level}
    </span>
  );
}

const columns: ColumnDef<RiskPageData>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.id}`}
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
      <span className="text-sm tabular-nums font-medium">
        {row.original.score}
      </span>
    ),
  },
  {
    accessorKey: "level",
    header: ({ column }) => (
      <SortableHeader column={column}>Level</SortableHeader>
    ),
    cell: ({ row }) => <LevelBadge level={row.original.level} />,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.entityType || "-"}
      </span>
    ),
  },
  {
    accessorKey: "quality",
    header: ({ column }) => (
      <SortableHeader column={column}>Quality</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.quality ?? "-"}
      </span>
    ),
  },
  {
    accessorKey: "factors",
    header: "Factors",
    cell: ({ row }) => (
      <div className="flex gap-1 flex-wrap max-w-xs">
        {row.original.factors.slice(0, 3).map((f) => (
          <span
            key={f}
            className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground"
          >
            {f}
          </span>
        ))}
        {row.original.factors.length > 3 && (
          <span className="text-[10px] text-muted-foreground">
            +{row.original.factors.length - 3}
          </span>
        )}
      </div>
    ),
    enableSorting: false,
  },
];

type FilterLevel = "all" | "high" | "medium" | "low";

export function HallucinationRiskDashboard({
  data,
}: {
  data: RiskPageData[];
}) {
  const [filterLevel, setFilterLevel] = useState<FilterLevel>("all");

  const filtered =
    filterLevel === "all"
      ? data
      : data.filter((d) => d.level === filterLevel);

  // Sort by score descending by default
  const sorted = [...filtered].sort((a, b) => b.score - a.score);

  return (
    <div className="not-prose">
      {/* Level filter tabs */}
      <div className="flex gap-2 mb-4">
        {(["all", "high", "medium", "low"] as const).map((level) => {
          const count =
            level === "all"
              ? data.length
              : data.filter((d) => d.level === level).length;
          return (
            <button
              key={level}
              onClick={() => setFilterLevel(level)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filterLevel === level
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {level === "all" ? "All" : level.charAt(0).toUpperCase() + level.slice(1)}{" "}
              <span className="tabular-nums">({count})</span>
            </button>
          );
        })}
      </div>

      <DataTable columns={columns} data={sorted} searchPlaceholder="Search pages..." />
    </div>
  );
}
