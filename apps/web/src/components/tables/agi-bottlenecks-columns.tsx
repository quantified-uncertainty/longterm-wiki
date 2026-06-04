"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { levelNoteColumn } from "./shared/column-helpers";

export type { AGIBottleneck, AGIBottleneckCategory } from "@data/tables/agi-bottlenecks";
import type { AGIBottleneck } from "@data/tables/agi-bottlenecks";

function ControllersCell({ controllers }: { controllers: string[] }) {
  return (
    <div className="flex flex-wrap gap-1 max-w-[220px]">
      {controllers.slice(0, 4).map((c) => (
        <span
          key={c}
          className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
        >
          {c}
        </span>
      ))}
      {controllers.length > 4 && (
        <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
          +{controllers.length - 4}
        </span>
      )}
    </div>
  );
}

function formatLevel(level: string): string {
  return level
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const createAGIBottlenecksColumns = (): ColumnDef<AGIBottleneck>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Bottleneck</SortableHeader>,
    cell: ({ row }) => {
      const b = row.original;
      return (
        <div className="min-w-[180px] max-w-[260px]">
          <div className="font-semibold text-[13px] text-foreground">{b.name}</div>
          <div className="text-[11px] text-muted-foreground mt-1 line-clamp-3">
            {b.description}
          </div>
        </div>
      );
    },
    enablePinning: true,
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
    cell: ({ row }) => (
      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200">
        {row.original.category}
      </span>
    ),
  },
  levelNoteColumn<AGIBottleneck>({
    id: "tightness",
    accessor: (r) => ({ level: r.tightness.level, note: r.tightness.note }),
    label: "Tightness",
    tooltip: "How constrained is this input right now?",
    badgeCategory: "tightness",
    formatLevel,
  }),
  levelNoteColumn<AGIBottleneck>({
    id: "trajectory",
    accessor: (r) => ({ level: r.trajectory.direction, note: r.trajectory.note }),
    label: "Trajectory",
    tooltip: "Is the constraint tightening or loosening?",
    badgeCategory: "trajectory",
    formatLevel,
  }),
  levelNoteColumn<AGIBottleneck>({
    id: "timeToRelieve",
    accessor: (r) => ({ level: r.timeToRelieve.horizon, note: r.timeToRelieve.note }),
    label: "Time to relieve",
    tooltip: "How fast can supply be expanded?",
    badgeCategory: "timeToRelieve",
    formatLevel,
  }),
  levelNoteColumn<AGIBottleneck>({
    id: "costToExpand",
    accessor: (r) => ({ level: r.costToExpand.level, note: r.costToExpand.note }),
    label: "Cost to expand",
    tooltip: "Capex required to relieve the constraint",
    badgeCategory: "cost",
    formatLevel,
  }),
  {
    id: "controllers",
    header: () => <span className="text-xs">Who controls</span>,
    cell: ({ row }) => <ControllersCell controllers={row.original.controllers} />,
    enableSorting: false,
  },
  levelNoteColumn<AGIBottleneck>({
    id: "geographicConcentration",
    accessor: (r) => ({
      level: r.geographicConcentration.level,
      note: r.geographicConcentration.note,
    }),
    label: "Geographic conc.",
    tooltip: "How geographically concentrated is supply?",
    badgeCategory: "geographicConcentration",
    formatLevel,
  }),
  {
    id: "notes",
    accessorKey: "notes",
    header: () => <span className="text-xs">Strategic notes</span>,
    cell: ({ row }) => (
      <div className="text-[11px] text-muted-foreground max-w-[260px]">
        {row.original.notes}
      </div>
    ),
    enableSorting: false,
  },
];

export const AGI_BOTTLENECKS_COLUMNS = {
  category: { key: "category", label: "Category", group: "overview" as const, default: false },
  tightness: { key: "tightness", label: "Tightness", group: "state" as const, default: true },
  trajectory: { key: "trajectory", label: "Trajectory", group: "state" as const, default: true },
  timeToRelieve: { key: "timeToRelieve", label: "Time to relieve", group: "supply" as const, default: true },
  costToExpand: { key: "costToExpand", label: "Cost to expand", group: "supply" as const, default: true },
  controllers: { key: "controllers", label: "Who controls", group: "control" as const, default: true },
  geographicConcentration: {
    key: "geographicConcentration",
    label: "Geographic conc.",
    group: "control" as const,
    default: true,
  },
  notes: { key: "notes", label: "Strategic notes", group: "assessment" as const, default: true },
} as const;

export type AGIBottlenecksColumnKey = keyof typeof AGI_BOTTLENECKS_COLUMNS;

export const AGI_BOTTLENECKS_PRESETS = {
  all: Object.keys(AGI_BOTTLENECKS_COLUMNS) as AGIBottlenecksColumnKey[],
  state: ["tightness", "trajectory"] as AGIBottlenecksColumnKey[],
  supply: ["tightness", "timeToRelieve", "costToExpand"] as AGIBottlenecksColumnKey[],
  control: ["tightness", "controllers", "geographicConcentration"] as AGIBottlenecksColumnKey[],
  compact: ["tightness", "trajectory", "timeToRelieve", "geographicConcentration"] as AGIBottlenecksColumnKey[],
  default: Object.entries(AGI_BOTTLENECKS_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as AGIBottlenecksColumnKey[],
};
