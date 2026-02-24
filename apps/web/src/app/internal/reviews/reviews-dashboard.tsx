"use client";

import { useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { ReviewedPageRow, UnreviewedHighRiskRow } from "./page";

// ---------------------------------------------------------------------------
// Reviewed pages table
// ---------------------------------------------------------------------------

function StaleBadge({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
      stale
    </span>
  );
}

function ScopeBadge({ scope }: { scope: string | undefined }) {
  if (!scope) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
      {scope}
    </span>
  );
}

const reviewedColumns: ColumnDef<ReviewedPageRow>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.pageId}`}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "reviewer",
    header: ({ column }) => (
      <SortableHeader column={column}>Reviewer</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm">{row.original.reviewer}</span>
    ),
  },
  {
    accessorKey: "date",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm tabular-nums text-muted-foreground">
        {row.original.date}
      </span>
    ),
  },
  {
    accessorKey: "daysSinceReview",
    header: ({ column }) => (
      <SortableHeader column={column}>Days Ago</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="text-sm tabular-nums text-muted-foreground">
          {row.original.daysSinceReview}d
        </span>
        <StaleBadge stale={row.original.stale} />
      </div>
    ),
  },
  {
    accessorKey: "scope",
    header: "Scope",
    cell: ({ row }) => <ScopeBadge scope={row.original.scope} />,
    enableSorting: false,
  },
  {
    accessorKey: "reviewCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Reviews</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.reviewCount}
      </span>
    ),
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
];

// ---------------------------------------------------------------------------
// Unreviewed high-risk pages table
// ---------------------------------------------------------------------------

function RiskLevelBadge({ level }: { level: "low" | "medium" | "high" }) {
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

const unreviewedColumns: ColumnDef<UnreviewedHighRiskRow>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.pageId}`}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "riskScore",
    header: ({ column }) => (
      <SortableHeader column={column}>Risk Score</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm tabular-nums font-medium">
        {row.original.riskScore}
      </span>
    ),
  },
  {
    accessorKey: "riskLevel",
    header: ({ column }) => (
      <SortableHeader column={column}>Risk Level</SortableHeader>
    ),
    cell: ({ row }) => <RiskLevelBadge level={row.original.riskLevel} />,
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
];

// ---------------------------------------------------------------------------
// Main dashboard component
// ---------------------------------------------------------------------------

type ActiveTab = "reviewed" | "unreviewed";

export function ReviewsDashboard({
  reviewedRows,
  unreviewedHighRisk,
}: {
  reviewedRows: ReviewedPageRow[];
  unreviewedHighRisk: UnreviewedHighRiskRow[];
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("reviewed");
  const [showStaleOnly, setShowStaleOnly] = useState(false);

  const filteredReviewed = showStaleOnly
    ? reviewedRows.filter((r) => r.stale)
    : reviewedRows;

  const staleCount = reviewedRows.filter((r) => r.stale).length;

  return (
    <div className="not-prose space-y-4">
      {/* Tab switcher */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setActiveTab("reviewed")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "reviewed"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Reviewed{" "}
          <span className="tabular-nums">({reviewedRows.length})</span>
        </button>
        <button
          onClick={() => setActiveTab("unreviewed")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "unreviewed"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Unreviewed High-Risk{" "}
          <span className="tabular-nums">({unreviewedHighRisk.length})</span>
        </button>
      </div>

      {/* Reviewed pages panel */}
      {activeTab === "reviewed" && (
        <div className="space-y-3">
          {staleCount > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowStaleOnly(!showStaleOnly)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  showStaleOnly
                    ? "bg-red-500/15 text-red-600"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                Stale only{" "}
                <span className="tabular-nums">({staleCount})</span>
              </button>
              {showStaleOnly && (
                <button
                  onClick={() => setShowStaleOnly(false)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                >
                  Show all
                </button>
              )}
            </div>
          )}
          {filteredReviewed.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No reviewed pages yet. Run{" "}
              <code className="text-[11px]">
                pnpm crux review mark &lt;page-id&gt; --reviewer=&quot;name&quot;
              </code>{" "}
              to mark a page as reviewed.
            </p>
          ) : (
            <DataTable
              columns={reviewedColumns}
              data={filteredReviewed}
              searchPlaceholder="Search reviewed pages..."
            />
          )}
        </div>
      )}

      {/* Unreviewed high-risk panel */}
      {activeTab === "unreviewed" && (
        <div className="space-y-3">
          {unreviewedHighRisk.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No unreviewed high-risk or medium-risk pages found.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Unreviewed pages with medium or high hallucination risk — sorted
                by risk score descending. These are the highest-priority
                candidates for human review.
              </p>
              <DataTable
                columns={unreviewedColumns}
                data={unreviewedHighRisk}
                searchPlaceholder="Search high-risk pages..."
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
