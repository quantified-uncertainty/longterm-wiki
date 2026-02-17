"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { RunRow } from "./page";

function StatusBadge({
  updated,
  failed,
}: {
  updated: number;
  failed: number;
}) {
  if (failed > 0) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
        {failed} failed
      </span>
    );
  }
  if (updated > 0) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-500">
        {updated} updated
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-muted text-muted-foreground">
      no updates
    </span>
  );
}

function TriggerBadge({ trigger }: { trigger: string }) {
  const isScheduled = trigger === "scheduled";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        isScheduled
          ? "bg-blue-500/10 text-blue-600"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {trigger}
    </span>
  );
}

const columns: ColumnDef<RunRow>[] = [
  {
    accessorKey: "date",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.date}
        <span className="ml-1.5 text-muted-foreground/60">
          ({formatAge(row.original.date)})
        </span>
      </span>
    ),
  },
  {
    accessorKey: "trigger",
    header: ({ column }) => (
      <SortableHeader column={column}>Trigger</SortableHeader>
    ),
    cell: ({ row }) => <TriggerBadge trigger={row.original.trigger} />,
  },
  {
    accessorKey: "sourcesChecked",
    header: ({ column }) => (
      <SortableHeader column={column}>Sources</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.sourcesChecked}
        {row.original.sourcesFailed > 0 && (
          <span className="text-red-500 ml-1">
            ({row.original.sourcesFailed} failed)
          </span>
        )}
      </span>
    ),
  },
  {
    accessorKey: "itemsFetched",
    header: ({ column }) => (
      <SortableHeader column={column}>Fetched</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.itemsFetched}
      </span>
    ),
  },
  {
    accessorKey: "itemsRelevant",
    header: ({ column }) => (
      <SortableHeader column={column}>Relevant</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.itemsRelevant}
      </span>
    ),
  },
  {
    accessorKey: "pagesUpdated",
    header: ({ column }) => (
      <SortableHeader column={column}>Result</SortableHeader>
    ),
    cell: ({ row }) => (
      <StatusBadge
        updated={row.original.pagesUpdated}
        failed={row.original.pagesFailed}
      />
    ),
  },
  {
    accessorKey: "budgetSpent",
    header: ({ column }) => (
      <SortableHeader column={column}>Budget</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        ${row.original.budgetSpent.toFixed(0)} / $
        {row.original.budgetLimit}
      </span>
    ),
  },
  {
    accessorKey: "durationMinutes",
    header: ({ column }) => (
      <SortableHeader column={column}>Duration</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.durationMinutes}m
      </span>
    ),
  },
];

export function RunsTable({ data }: { data: RunRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search runs..."
      defaultSorting={[{ id: "date", desc: true }]}
      getRowClassName={(row) =>
        row.original.pagesFailed > 0 ? "bg-red-500/[0.03]" : ""
      }
    />
  );
}
