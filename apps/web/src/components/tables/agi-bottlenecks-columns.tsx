"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { getLevelSortValue } from "./shared/table-view-styles";
import { LevelBadge, CellNote } from "./shared/cell-components";

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
  {
    id: "tightness",
    accessorFn: (row) => row.tightness.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How constrained is this input right now?">
        Tightness
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.tightness.level} category="tightness" formatLevel={formatLevel} />
        <CellNote note={row.original.tightness.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      return (
        getLevelSortValue(rowA.original.tightness.level) -
        getLevelSortValue(rowB.original.tightness.level)
      );
    },
  },
  {
    id: "trajectory",
    accessorFn: (row) => row.trajectory.direction,
    header: ({ column }) => (
      <SortableHeader column={column} title="Is the constraint tightening or loosening?">
        Trajectory
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge
          level={row.original.trajectory.direction}
          category="trajectory"
          formatLevel={formatLevel}
        />
        <CellNote note={row.original.trajectory.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      return (
        getLevelSortValue(rowA.original.trajectory.direction) -
        getLevelSortValue(rowB.original.trajectory.direction)
      );
    },
  },
  {
    id: "timeToRelieve",
    accessorFn: (row) => row.timeToRelieve.horizon,
    header: ({ column }) => (
      <SortableHeader column={column} title="How fast can supply be expanded?">
        Time to relieve
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge
          level={row.original.timeToRelieve.horizon}
          category="timeToRelieve"
          formatLevel={formatLevel}
        />
        <CellNote note={row.original.timeToRelieve.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      return (
        getLevelSortValue(rowA.original.timeToRelieve.horizon) -
        getLevelSortValue(rowB.original.timeToRelieve.horizon)
      );
    },
  },
  {
    id: "costToExpand",
    accessorFn: (row) => row.costToExpand.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Capex required to relieve the constraint">
        Cost to expand
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge
          level={row.original.costToExpand.level}
          category="cost"
          formatLevel={formatLevel}
        />
        <CellNote note={row.original.costToExpand.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      return (
        getLevelSortValue(rowA.original.costToExpand.level) -
        getLevelSortValue(rowB.original.costToExpand.level)
      );
    },
  },
  {
    id: "controllers",
    header: () => <span className="text-xs">Who controls</span>,
    cell: ({ row }) => <ControllersCell controllers={row.original.controllers} />,
    enableSorting: false,
  },
  {
    id: "geographicConcentration",
    accessorFn: (row) => row.geographicConcentration.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How geographically concentrated is supply?">
        Geographic conc.
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge
          level={row.original.geographicConcentration.level}
          category="geographicConcentration"
          formatLevel={formatLevel}
        />
        <CellNote note={row.original.geographicConcentration.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      return (
        getLevelSortValue(rowA.original.geographicConcentration.level) -
        getLevelSortValue(rowB.original.geographicConcentration.level)
      );
    },
  },
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
