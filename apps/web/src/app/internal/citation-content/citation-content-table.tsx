"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { ContentEntry } from "./page";

function StatusBadge({ httpStatus }: { httpStatus: number | null }) {
  if (httpStatus === null) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        unknown
      </span>
    );
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-600">
        {httpStatus}
      </span>
    );
  }
  if (httpStatus >= 400) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
        {httpStatus}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-500/15 text-yellow-600">
      {httpStatus}
    </span>
  );
}

function CoverageBadge({ has }: { has: boolean }) {
  return has ? (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-600">
      yes
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
      no
    </span>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const columns: ColumnDef<ContentEntry>[] = [
  {
    accessorKey: "url",
    header: ({ column }) => <SortableHeader column={column}>URL</SortableHeader>,
    cell: ({ row }) => {
      const url = row.original.url;
      const domain = getDomain(url);
      const title = row.original.pageTitle;
      return (
        <div className="max-w-xs">
          {title && (
            <p className="text-xs font-medium text-foreground truncate">
              {title}
            </p>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground hover:text-foreground truncate block"
            title={url}
          >
            {domain}
          </a>
        </div>
      );
    },
  },
  {
    accessorKey: "fetchedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Fetched</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {new Date(row.original.fetchedAt).toLocaleDateString()}
      </span>
    ),
  },
  {
    accessorKey: "httpStatus",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => <StatusBadge httpStatus={row.original.httpStatus} />,
  },
  {
    accessorKey: "contentLength",
    header: ({ column }) => (
      <SortableHeader column={column}>Size</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {formatBytes(row.original.contentLength)}
      </span>
    ),
  },
  {
    accessorKey: "hasFullText",
    header: ({ column }) => (
      <SortableHeader column={column}>Full Text</SortableHeader>
    ),
    cell: ({ row }) => <CoverageBadge has={row.original.hasFullText} />,
  },
  {
    accessorKey: "hasPreview",
    header: ({ column }) => (
      <SortableHeader column={column}>Preview</SortableHeader>
    ),
    cell: ({ row }) => <CoverageBadge has={row.original.hasPreview} />,
  },
];

export function CitationContentTable({ data }: { data: ContentEntry[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search URLs or titles..."
      defaultSorting={[{ id: "fetchedAt", desc: true }]}
      getRowClassName={(row) =>
        row.original.httpStatus !== null && row.original.httpStatus >= 400
          ? "bg-red-500/[0.03]"
          : ""
      }
    />
  );
}
