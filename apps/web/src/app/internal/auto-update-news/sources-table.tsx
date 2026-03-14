"use client";

import {
  ServerPaginatedTable,
  type ColumnDef,
} from "@/components/server-paginated-table";
import type { SourceRow } from "./auto-update-news-content";

const columns: ColumnDef<SourceRow>[] = [
  {
    id: "enabled",
    header: "Status",
    sortField: "enabled",
    accessor: (row) =>
      row.enabled ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-600">
          ON
        </span>
      ) : (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
          OFF
        </span>
      ),
  },
  {
    id: "name",
    header: "Name",
    sortField: "name",
    accessor: (row) => (
      <span className="text-sm font-medium text-foreground">{row.name}</span>
    ),
  },
  {
    id: "type",
    header: "Type",
    sortField: "type",
    accessor: (row) => (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        {row.type}
      </span>
    ),
  },
  {
    id: "frequency",
    header: "Frequency",
    sortField: "frequency",
    accessor: (row) => (
      <span className="text-xs text-muted-foreground">{row.frequency}</span>
    ),
  },
  {
    id: "reliability",
    header: "Reliability",
    sortField: "reliability",
    accessor: (row) => {
      const r = row.reliability;
      const color =
        r === "high"
          ? "bg-emerald-500/15 text-emerald-600"
          : r === "medium"
            ? "bg-amber-500/15 text-amber-600"
            : "bg-red-500/15 text-red-500";
      return (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}
        >
          {r}
        </span>
      );
    },
  },
  {
    id: "categories",
    header: "Categories",
    accessor: (row) => (
      <span className="text-[11px] text-muted-foreground">
        {row.categories}
      </span>
    ),
  },
  {
    id: "lastFetched",
    header: "Last Fetched",
    sortField: "lastFetched",
    accessor: (row) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.lastFetched
          ? row.lastFetched.slice(0, 16).replace("T", " ")
          : "\u2014"}
      </span>
    ),
  },
];

export function SourcesTable({ data }: { data: SourceRow[] }) {
  return (
    <ServerPaginatedTable<SourceRow>
      columns={columns}
      rows={data}
      rowKey={(row) => row.id}
      defaultSortId="enabled"
      defaultSortDir="desc"
      searchPlaceholder="Search sources..."
      itemLabel="sources"
      searchFields={["name", "type", "categories", "reliability"]}
      showColumnPicker={false}
      staticSort={(a, b, sortId, dir) => {
        let cmp = 0;
        if (sortId === "enabled") {
          cmp = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0);
        } else if (sortId === "name") {
          cmp = a.name.localeCompare(b.name);
        } else if (sortId === "type") {
          cmp = a.type.localeCompare(b.type);
        } else if (sortId === "frequency") {
          cmp = a.frequency.localeCompare(b.frequency);
        } else if (sortId === "reliability") {
          const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
          cmp = (order[a.reliability] ?? 3) - (order[b.reliability] ?? 3);
        } else if (sortId === "lastFetched") {
          cmp = (a.lastFetched ?? "").localeCompare(b.lastFetched ?? "");
        }
        return dir === "asc" ? cmp : -cmp;
      }}
    />
  );
}
