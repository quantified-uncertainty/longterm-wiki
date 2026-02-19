"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { VERDICT_COLORS } from "./verdict-colors";
import type { PageSummary, FlaggedCitation, DomainSummary } from "./page";

// ---------------------------------------------------------------------------
// Page Accuracy Table
// ---------------------------------------------------------------------------

function AccuracyBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground">-</span>;
  const pct = Math.round(rate * 100);
  const color =
    pct >= 90
      ? "bg-emerald-500"
      : pct >= 75
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function VerdictBadgeSmall({ verdict }: { verdict: string }) {
  const colorClass = VERDICT_COLORS[verdict] || "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${colorClass}`}
    >
      {verdict.replace(/_/g, " ")}
    </span>
  );
}

const pageColumns: ColumnDef<PageSummary>[] = [
  {
    accessorKey: "pageId",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-medium">{row.original.pageId}</span>
    ),
  },
  {
    accessorKey: "totalCitations",
    header: ({ column }) => (
      <SortableHeader column={column}>Citations</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.totalCitations}
      </span>
    ),
  },
  {
    accessorKey: "checked",
    header: ({ column }) => (
      <SortableHeader column={column}>Checked</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.checked}
      </span>
    ),
  },
  {
    accessorKey: "accurate",
    header: ({ column }) => (
      <SortableHeader column={column}>Accurate</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-emerald-600">
        {row.original.accurate > 0 ? row.original.accurate : ""}
      </span>
    ),
  },
  {
    accessorKey: "inaccurate",
    header: ({ column }) => (
      <SortableHeader column={column}>Issues</SortableHeader>
    ),
    cell: ({ row }) => {
      const issues = row.original.inaccurate + row.original.unsupported;
      if (issues === 0) return null;
      return (
        <span className="text-xs tabular-nums text-red-600 font-medium">
          {issues}
        </span>
      );
    },
  },
  {
    accessorKey: "accuracyRate",
    header: ({ column }) => (
      <SortableHeader column={column}>Accuracy</SortableHeader>
    ),
    cell: ({ row }) => <AccuracyBar rate={row.original.accuracyRate} />,
    sortingFn: (a, b) => {
      const aRate = a.original.accuracyRate ?? -1;
      const bRate = b.original.accuracyRate ?? -1;
      return aRate - bRate;
    },
  },
  {
    accessorKey: "avgScore",
    header: ({ column }) => (
      <SortableHeader column={column}>Avg Score</SortableHeader>
    ),
    cell: ({ row }) => {
      const score = row.original.avgScore;
      if (score === null || !Number.isFinite(score)) return null;
      return (
        <span className="text-xs tabular-nums text-muted-foreground">
          {score.toFixed(2)}
        </span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Flagged Citations Table
// ---------------------------------------------------------------------------

const flaggedColumns: ColumnDef<FlaggedCitation>[] = [
  {
    accessorKey: "pageId",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-medium">{row.original.pageId}</span>
    ),
  },
  {
    accessorKey: "footnote",
    header: ({ column }) => (
      <SortableHeader column={column}>#</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        [{row.original.footnote}]
      </span>
    ),
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => (
      <SortableHeader column={column}>Verdict</SortableHeader>
    ),
    cell: ({ row }) => <VerdictBadgeSmall verdict={row.original.verdict} />,
  },
  {
    accessorKey: "score",
    header: ({ column }) => (
      <SortableHeader column={column}>Score</SortableHeader>
    ),
    cell: ({ row }) => {
      const score = row.original.score;
      if (score === null || !Number.isFinite(score)) return null;
      return (
        <span className="text-xs tabular-nums text-muted-foreground">
          {score.toFixed(2)}
        </span>
      );
    },
  },
  {
    accessorKey: "claimText",
    header: "Claim",
    cell: ({ row }) => (
      <div className="max-w-md">
        <p className="text-xs text-foreground line-clamp-2">
          {row.original.claimText}
        </p>
        {row.original.issues && (
          <p className="text-[11px] text-red-500 mt-0.5 line-clamp-1">
            {row.original.issues}
          </p>
        )}
      </div>
    ),
  },
  {
    accessorKey: "difficulty",
    header: ({ column }) => (
      <SortableHeader column={column}>Difficulty</SortableHeader>
    ),
    cell: ({ row }) => {
      if (!row.original.difficulty) return null;
      return (
        <span className="text-[11px] text-muted-foreground">
          {row.original.difficulty}
        </span>
      );
    },
  },
  {
    accessorKey: "sourceTitle",
    header: "Source",
    cell: ({ row }) => {
      const { sourceTitle, url } = row.original;
      if (!sourceTitle && !url) return null;
      const label = sourceTitle || url || "";
      const truncated =
        label.length > 40 ? label.slice(0, 40) + "..." : label;
      if (url) {
        return (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-blue-600 hover:underline"
          >
            {truncated}
          </a>
        );
      }
      return (
        <span className="text-[11px] text-muted-foreground">{truncated}</span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Domain Analysis Table
// ---------------------------------------------------------------------------

const domainColumns: ColumnDef<DomainSummary>[] = [
  {
    accessorKey: "domain",
    header: ({ column }) => (
      <SortableHeader column={column}>Domain</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-medium">{row.original.domain}</span>
    ),
  },
  {
    accessorKey: "totalCitations",
    header: ({ column }) => (
      <SortableHeader column={column}>Citations</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.totalCitations}
      </span>
    ),
  },
  {
    accessorKey: "checked",
    header: ({ column }) => (
      <SortableHeader column={column}>Checked</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.checked}
      </span>
    ),
  },
  {
    accessorKey: "accurate",
    header: ({ column }) => (
      <SortableHeader column={column}>Accurate</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-emerald-600">
        {row.original.accurate > 0 ? row.original.accurate : ""}
      </span>
    ),
  },
  {
    accessorKey: "inaccurate",
    header: ({ column }) => (
      <SortableHeader column={column}>Issues</SortableHeader>
    ),
    cell: ({ row }) => {
      const issues = row.original.inaccurate + row.original.unsupported;
      if (issues === 0) return null;
      return (
        <span className="text-xs tabular-nums text-red-600 font-medium">
          {issues}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const aIssues = a.original.inaccurate + a.original.unsupported;
      const bIssues = b.original.inaccurate + b.original.unsupported;
      return aIssues - bIssues;
    },
  },
  {
    accessorKey: "inaccuracyRate",
    header: ({ column }) => (
      <SortableHeader column={column}>Error Rate</SortableHeader>
    ),
    cell: ({ row }) => {
      const rate = row.original.inaccuracyRate;
      if (rate === null) return null;
      const pct = Math.round(rate * 100);
      return (
        <span
          className={`text-xs tabular-nums font-medium ${pct > 20 ? "text-red-600" : pct > 0 ? "text-amber-600" : "text-muted-foreground"}`}
        >
          {pct}%
        </span>
      );
    },
    sortingFn: (a, b) => {
      const aRate = a.original.inaccuracyRate ?? -1;
      const bRate = b.original.inaccuracyRate ?? -1;
      return aRate - bRate;
    },
  },
];

// ---------------------------------------------------------------------------
// Tab Switcher
// ---------------------------------------------------------------------------

type Tab = "pages" | "flagged" | "domains";

export function CitationAccuracyDashboard({
  pages,
  flaggedCitations,
  domainAnalysis,
}: {
  pages: PageSummary[];
  flaggedCitations: FlaggedCitation[];
  domainAnalysis: DomainSummary[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>("pages");

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "pages", label: "Pages", count: pages.length },
    { id: "flagged", label: "Flagged Citations", count: flaggedCitations.length },
    { id: "domains", label: "Domains", count: domainAnalysis.length },
  ];

  return (
    <div className="not-prose">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
              ({tab.count})
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "pages" && (
        <DataTable
          columns={pageColumns}
          data={pages}
          searchPlaceholder="Search pages..."
          defaultSorting={[{ id: "accuracyRate", desc: false }]}
          getRowClassName={(row) => {
            const issues =
              row.original.inaccurate + row.original.unsupported;
            return issues > 0 ? "bg-red-500/[0.03]" : "";
          }}
        />
      )}

      {activeTab === "flagged" && (
        <>
          {flaggedCitations.length === 0 ? (
            <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground">
              <p className="text-sm">No flagged citations found.</p>
            </div>
          ) : (
            <DataTable
              columns={flaggedColumns}
              data={flaggedCitations}
              searchPlaceholder="Search flagged citations..."
              defaultSorting={[{ id: "score", desc: false }]}
              getRowClassName={() => "bg-red-500/[0.02]"}
            />
          )}
        </>
      )}

      {activeTab === "domains" && (
        <>
          {domainAnalysis.length === 0 ? (
            <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground">
              <p className="text-sm">
                Not enough data for domain analysis (need 2+ citations per
                domain).
              </p>
            </div>
          ) : (
            <DataTable
              columns={domainColumns}
              data={domainAnalysis}
              searchPlaceholder="Search domains..."
              defaultSorting={[{ id: "inaccuracyRate", desc: true }]}
              getRowClassName={(row) =>
                row.original.inaccurate > 0 ? "bg-red-500/[0.03]" : ""
              }
            />
          )}
        </>
      )}
    </div>
  );
}
