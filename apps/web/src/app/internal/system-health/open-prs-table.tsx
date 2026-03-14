"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { GITHUB_REPO_URL } from "@lib/site-config";

// ── Types ──────────────────────────────────────────────────────────────────

export interface OpenPRDisplayRow {
  number: number;
  title: string;
  branch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  ciStatus: "success" | "failure" | "pending" | "error" | "unknown";
  mergeable: "mergeable" | "conflicting" | "unknown";
}

// ── CI Status Badge ────────────────────────────────────────────────────────

const CI_STYLES: Record<string, { cls: string; label: string }> = {
  success: { cls: "bg-green-500/15 text-green-600", label: "passing" },
  failure: { cls: "bg-red-500/15 text-red-500", label: "failing" },
  pending: { cls: "bg-yellow-500/15 text-yellow-600", label: "building" },
  error: { cls: "bg-red-500/15 text-red-500", label: "error" },
  unknown: { cls: "bg-muted text-muted-foreground", label: "unknown" },
};

function CiStatusBadge({ status }: { status: string }) {
  const style = CI_STYLES[status] ?? CI_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}
    >
      {style.label}
    </span>
  );
}

// ── Merge Status Badge ─────────────────────────────────────────────────────

const MERGE_STYLES: Record<string, { cls: string; label: string }> = {
  mergeable: { cls: "bg-green-500/15 text-green-600", label: "clean" },
  conflicting: { cls: "bg-red-500/15 text-red-500", label: "conflicts" },
  unknown: { cls: "bg-muted text-muted-foreground", label: "pending" },
};

function MergeStatusBadge({ status }: { status: string }) {
  const style = MERGE_STYLES[status] ?? MERGE_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}
    >
      {style.label}
    </span>
  );
}

// ── Relative Time ──────────────────────────────────────────────────────────

function RelativeTime({ date }: { date: string }) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const hoursAgo = Math.round((now - then) / 3600000);

  let label: string;
  if (hoursAgo < 1) label = "<1h ago";
  else if (hoursAgo < 24) label = `${hoursAgo}h ago`;
  else label = `${Math.round(hoursAgo / 24)}d ago`;

  return (
    <span className="text-xs text-muted-foreground tabular-nums" suppressHydrationWarning>{label}</span>
  );
}

// ── Columns ────────────────────────────────────────────────────────────────

const columns: ColumnDef<OpenPRDisplayRow>[] = [
  {
    accessorKey: "number",
    header: ({ column }) => (
      <SortableHeader column={column}>PR</SortableHeader>
    ),
    cell: ({ row }) => {
      const pr = row.original;
      return (
        <a
          href={`${GITHUB_REPO_URL}/pull/${pr.number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline tabular-nums font-medium"
        >
          #{pr.number}
          {pr.isDraft && (
            <span className="ml-1 text-muted-foreground font-normal">
              (draft)
            </span>
          )}
        </a>
      );
    },
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <a
        href={`${GITHUB_REPO_URL}/pull/${row.original.number}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm max-w-[300px] block truncate hover:underline"
        title={row.original.title}
      >
        {row.original.title}
      </a>
    ),
  },
  {
    accessorKey: "author",
    header: "Author",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.author}
      </span>
    ),
  },
  {
    accessorKey: "ciStatus",
    header: ({ column }) => (
      <SortableHeader column={column}>CI</SortableHeader>
    ),
    cell: ({ row }) => <CiStatusBadge status={row.original.ciStatus} />,
  },
  {
    accessorKey: "mergeable",
    header: ({ column }) => (
      <SortableHeader column={column}>Merge</SortableHeader>
    ),
    cell: ({ row }) => <MergeStatusBadge status={row.original.mergeable} />,
  },
  {
    accessorKey: "additions",
    header: ({ column }) => (
      <SortableHeader column={column}>Size</SortableHeader>
    ),
    cell: ({ row }) => {
      const { additions, deletions } = row.original;
      return (
        <span className="text-xs tabular-nums">
          <span className="text-green-600">+{additions}</span>
          {" / "}
          <span className="text-red-500">-{deletions}</span>
        </span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.additions + rowA.original.deletions;
      const b = rowB.original.additions + rowB.original.deletions;
      return a - b;
    },
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Updated</SortableHeader>
    ),
    cell: ({ row }) => <RelativeTime date={row.original.updatedAt} />,
    sortingFn: "datetime",
  },
];

// ── Table Component ────────────────────────────────────────────────────────

export function OpenPRsTable({ data }: { data: OpenPRDisplayRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "updatedAt", desc: true }]}
      searchPlaceholder="Search PRs..."
    />
  );
}
