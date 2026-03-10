"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { VerdictRow } from "./kb-verifications-content";

// ── Verdict badge ─────────────────────────────────────────────────────────────

const VERDICT_BADGE_STYLES: Record<string, string> = {
  confirmed: "bg-emerald-500/15 text-emerald-500",
  contradicted: "bg-red-500/15 text-red-500",
  outdated: "bg-amber-500/15 text-amber-500",
  partial: "bg-amber-400/15 text-amber-600",
  unverifiable: "bg-gray-500/15 text-gray-500",
  unchecked: "bg-gray-400/15 text-gray-400",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  const style = VERDICT_BADGE_STYLES[verdict] || "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {verdict}
    </span>
  );
}

// ── Columns ───────────────────────────────────────────────────────────────────

const columns: ColumnDef<VerdictRow>[] = [
  {
    accessorKey: "entityId",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => {
      const entityId = row.original.entityId;
      if (!entityId) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <a
          href={`/wiki/${entityId}`}
          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {entityId}
        </a>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "factId",
    header: ({ column }) => (
      <SortableHeader column={column}>Fact</SortableHeader>
    ),
    cell: ({ row }) => {
      const label = row.original.factLabel;
      const factId = row.original.factId;
      return (
        <div className="flex flex-col gap-0.5">
          {label && (
            <span className="text-xs font-medium text-foreground">{label}</span>
          )}
          <span className="text-[11px] font-mono text-muted-foreground">
            {factId}
          </span>
        </div>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => (
      <SortableHeader column={column}>Verdict</SortableHeader>
    ),
    cell: ({ row }) => <VerdictBadge verdict={row.original.verdict} />,
  },
  {
    accessorKey: "confidence",
    header: ({ column }) => (
      <SortableHeader column={column}>Confidence</SortableHeader>
    ),
    cell: ({ row }) => {
      const c = row.original.confidence;
      if (c == null) return <span className="text-xs text-muted-foreground">-</span>;
      const pct = Math.round(c * 100);
      return (
        <span className="text-sm tabular-nums font-medium">{pct}%</span>
      );
    },
  },
  {
    accessorKey: "reasoning",
    header: "Reasoning",
    cell: ({ row }) => {
      const r = row.original.reasoning;
      if (!r) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground line-clamp-2 max-w-[300px]" title={r}>
          {r}
        </span>
      );
    },
  },
  {
    accessorKey: "sourcesChecked",
    header: ({ column }) => (
      <SortableHeader column={column}>Sources</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">
        {row.original.sourcesChecked}
      </span>
    ),
  },
  {
    accessorKey: "needsRecheck",
    header: ({ column }) => (
      <SortableHeader column={column}>Recheck</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.needsRecheck ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
          yes
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">no</span>
      ),
  },
  {
    accessorKey: "lastComputedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Computed</SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.lastComputedAt;
      if (!d) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {new Date(d).toLocaleDateString()}
        </span>
      );
    },
  },
];

// ── Table component ───────────────────────────────────────────────────────────

export function KbVerificationsTable({ data }: { data: VerdictRow[] }) {
  const [filterVerdict, setFilterVerdict] = useState<string>("all");

  // Compute unique verdicts for filter buttons
  const verdictCounts = new Map<string, number>();
  for (const row of data) {
    verdictCounts.set(row.verdict, (verdictCounts.get(row.verdict) ?? 0) + 1);
  }
  const verdictTypes = [...verdictCounts.keys()].sort();

  const filtered =
    filterVerdict === "all"
      ? data
      : data.filter((d) => d.verdict === filterVerdict);

  return (
    <div className="not-prose">
      {/* Verdict filter tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setFilterVerdict("all")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            filterVerdict === "all"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          All <span className="tabular-nums">({data.length})</span>
        </button>
        {verdictTypes.map((v) => (
          <button
            key={v}
            onClick={() => setFilterVerdict(v)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filterVerdict === v
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {v}{" "}
            <span className="tabular-nums">({verdictCounts.get(v) ?? 0})</span>
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        defaultSorting={[{ id: "confidence", desc: true }]}
        searchPlaceholder="Search facts..."
      />
    </div>
  );
}
