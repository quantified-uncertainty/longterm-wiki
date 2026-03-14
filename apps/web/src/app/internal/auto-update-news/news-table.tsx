"use client";

import {
  ServerPaginatedTable,
  type ColumnDef,
} from "@/components/server-paginated-table";
import type { NewsRow } from "./auto-update-news-content";

function RelevanceBadge({ score }: { score: number }) {
  const color =
    score >= 70
      ? "bg-emerald-500/15 text-emerald-600"
      : score >= 40
        ? "bg-amber-500/15 text-amber-600"
        : "bg-muted text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${color}`}
    >
      {score}
    </span>
  );
}

function RoutingBadge({
  routedTo,
  tier,
}: {
  routedTo: string | null;
  tier: string | null;
}) {
  if (!routedTo) {
    return (
      <span className="text-[11px] text-muted-foreground/50 italic">
        not routed
      </span>
    );
  }

  const tierColor =
    tier === "deep"
      ? "bg-red-500/10 text-red-600"
      : tier === "standard"
        ? "bg-blue-500/10 text-blue-600"
        : "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-foreground truncate max-w-[180px]">
        {routedTo}
      </span>
      <span
        className={`inline-flex items-center self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tierColor}`}
      >
        {tier}
      </span>
    </div>
  );
}

const columns: ColumnDef<NewsRow>[] = [
  {
    id: "relevanceScore",
    header: "Score",
    sortField: "relevanceScore",
    align: "right" as const,
    accessor: (row) => <RelevanceBadge score={row.relevanceScore} />,
  },
  {
    id: "title",
    header: "Title",
    sortField: "title",
    accessor: (row) => (
      <div className="max-w-[350px]">
        {row.url ? (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-accent-foreground hover:underline no-underline"
          >
            {row.title}
          </a>
        ) : (
          <span className="text-sm font-medium text-foreground">
            {row.title}
          </span>
        )}
        {row.summary && (
          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
            {row.summary.slice(0, 200)}
          </p>
        )}
      </div>
    ),
  },
  {
    id: "sourceId",
    header: "Source",
    sortField: "sourceId",
    accessor: (row) => (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        {row.sourceId}
      </span>
    ),
  },
  {
    id: "publishedAt",
    header: "Published",
    sortField: "publishedAt",
    accessor: (row) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.publishedAt}
      </span>
    ),
  },
  {
    id: "routedTo",
    header: "Routed To",
    sortField: "routedTo",
    accessor: (row) => (
      <RoutingBadge routedTo={row.routedTo} tier={row.routedTier} />
    ),
  },
  {
    id: "runDate",
    header: "Run",
    sortField: "runDate",
    accessor: (row) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.runDate}
      </span>
    ),
  },
];

export function NewsTable({ data }: { data: NewsRow[] }) {
  return (
    <ServerPaginatedTable<NewsRow>
      columns={columns}
      rows={data}
      rowKey={(row) => `${row.runDate}-${row.title}`}
      defaultSortId="relevanceScore"
      defaultSortDir="desc"
      searchPlaceholder="Search news items..."
      itemLabel="news items"
      searchFields={["title", "sourceId", "summary", "routedTo"]}
      staticSort={(a, b, sortId, dir) => {
        let cmp = 0;
        if (sortId === "relevanceScore") {
          cmp = a.relevanceScore - b.relevanceScore;
        } else if (sortId === "title") {
          cmp = a.title.localeCompare(b.title);
        } else if (sortId === "sourceId") {
          cmp = a.sourceId.localeCompare(b.sourceId);
        } else if (sortId === "publishedAt") {
          cmp = a.publishedAt.localeCompare(b.publishedAt);
        } else if (sortId === "routedTo") {
          cmp = (a.routedTo ? 1 : 0) - (b.routedTo ? 1 : 0);
        } else if (sortId === "runDate") {
          cmp = a.runDate.localeCompare(b.runDate);
        }
        return dir === "asc" ? cmp : -cmp;
      }}
    />
  );
}
