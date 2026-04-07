"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { freshnessSortKey, type Freshness } from "@/app/data-sources/freshness";
import {
  FORMAT_LABELS, FORMAT_COLORS,
  RECORD_TYPE_LABELS, RECORD_TYPE_COLORS,
} from "@/app/data-sources/data-source-labels";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Row type (enriched server-side, passed as props)
// ---------------------------------------------------------------------------

export interface DataSourceRow {
  id: string;
  name: string;
  resourceId: string | null;
  dataFormat: string;
  recordType: string;
  publisherName: string | null;
  publisherHref: string | null;
  updateFrequency: string | null;
  lastSnapshotAt: string | null;
  snapshotRecordCount: number | null;
  sourceStatus: string;
  latestSnapshotHash: string | null;
  freshness: Freshness;
}

const FRESHNESS_STYLES: Record<
  Freshness,
  { label: string; bg: string; text: string }
> = {
  fresh: {
    label: "Fresh",
    bg: "bg-emerald-100 dark:bg-emerald-900/40",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  due: {
    label: "Due",
    bg: "bg-amber-100 dark:bg-amber-900/40",
    text: "text-amber-700 dark:text-amber-300",
  },
  overdue: {
    label: "Overdue",
    bg: "bg-red-100 dark:bg-red-900/40",
    text: "text-red-700 dark:text-red-300",
  },
  static: {
    label: "Static",
    bg: "bg-gray-100 dark:bg-gray-900/40",
    text: "text-gray-600 dark:text-gray-400",
  },
  unknown: {
    label: "Unknown",
    bg: "bg-gray-100 dark:bg-gray-900/40",
    text: "text-gray-600 dark:text-gray-400",
  },
};

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "text-blue-600" },
  archived: { label: "Archived", color: "text-muted-foreground" },
  defunct: { label: "Defunct", color: "text-red-600" },
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`text-xs font-medium ${color}`}>{label}</span>
  );
}

function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const style = FRESHNESS_STYLES[freshness];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {style.label}
    </span>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return iso;
  const days = Math.round(ms / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<DataSourceRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Name</SortableHeader>
    ),
    cell: ({ row }) => {
      const { name, resourceId } = row.original;
      if (!resourceId) {
        return <span className="text-sm font-medium">{name}</span>;
      }
      return (
        <Link
          href={`/resources/${resourceId}`}
          className="text-sm font-medium text-accent-foreground hover:underline"
        >
          {name}
        </Link>
      );
    },
    filterFn: "includesString",
    size: 240,
  },
  {
    accessorKey: "dataFormat",
    header: ({ column }) => (
      <SortableHeader column={column}>Format</SortableHeader>
    ),
    cell: ({ row }) => {
      const fmt = row.original.dataFormat;
      const label = FORMAT_LABELS[fmt];
      const color = FORMAT_COLORS[fmt] ?? "text-muted-foreground";
      return label ? (
        <Badge label={label} color={color} />
      ) : (
        <span className="text-xs text-muted-foreground">{fmt}</span>
      );
    },
    size: 80,
  },
  {
    accessorKey: "recordType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => {
      const rt = row.original.recordType;
      const label = RECORD_TYPE_LABELS[rt];
      const color = RECORD_TYPE_COLORS[rt] ?? "text-muted-foreground";
      return label ? (
        <Badge label={label} color={color} />
      ) : (
        <span className="text-xs text-muted-foreground">{rt}</span>
      );
    },
    size: 90,
  },
  {
    accessorKey: "publisherName",
    header: "Publisher",
    cell: ({ row }) => {
      const { publisherName, publisherHref } = row.original;
      if (!publisherName) {
        return <span className="text-muted-foreground text-xs">—</span>;
      }
      if (publisherHref) {
        return (
          <Link
            href={publisherHref}
            className="text-xs hover:underline text-accent-foreground"
          >
            {publisherName}
          </Link>
        );
      }
      return <span className="text-xs">{publisherName}</span>;
    },
    size: 150,
  },
  {
    accessorKey: "updateFrequency",
    header: ({ column }) => (
      <SortableHeader column={column}>Frequency</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground capitalize">
        {row.original.updateFrequency ?? "—"}
      </span>
    ),
    size: 90,
  },
  {
    accessorKey: "lastSnapshotAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Snapshot</SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.lastSnapshotAt;
      if (!d)
        return <span className="text-xs text-muted-foreground">never</span>;
      return (
        <span
          className="text-xs tabular-nums"
          title={new Date(d).toISOString()}
        >
          {relativeTime(d)}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const aVal = a.original.lastSnapshotAt;
      const bVal = b.original.lastSnapshotAt;
      if (!aVal && !bVal) return 0;
      if (!aVal) return 1;
      if (!bVal) return -1;
      return new Date(aVal).getTime() - new Date(bVal).getTime();
    },
    size: 110,
  },
  {
    accessorKey: "snapshotRecordCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Records</SortableHeader>
    ),
    cell: ({ row }) => {
      const { snapshotRecordCount: count, recordType, id } = row.original;
      if (count == null) return <span className="text-xs text-muted-foreground">—</span>;
      if (recordType === "grant") {
        return (
          <Link
            href={`/grants?dataSource=${id}`}
            className="text-xs tabular-nums text-accent-foreground hover:underline"
          >
            {count.toLocaleString()}
          </Link>
        );
      }
      return <span className="text-xs tabular-nums">{count.toLocaleString()}</span>;
    },
    size: 80,
  },
  {
    accessorKey: "freshness",
    header: ({ column }) => (
      <SortableHeader column={column}>Freshness</SortableHeader>
    ),
    cell: ({ row }) => <FreshnessBadge freshness={row.original.freshness} />,
    sortingFn: (a, b) =>
      freshnessSortKey(a.original.freshness) -
      freshnessSortKey(b.original.freshness),
    size: 90,
  },
  {
    accessorKey: "sourceStatus",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => {
      const style = STATUS_STYLES[row.original.sourceStatus];
      return style ? (
        <Badge label={style.label} color={style.color} />
      ) : (
        <span className="text-xs">{row.original.sourceStatus}</span>
      );
    },
    size: 80,
  },
];

// ---------------------------------------------------------------------------
// Table component
// ---------------------------------------------------------------------------

export function DataSourcesTable({ rows }: { rows: DataSourceRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search data sources..."
      defaultSorting={[{ id: "freshness", desc: false }]}
      pageSize={50}
    />
  );
}
