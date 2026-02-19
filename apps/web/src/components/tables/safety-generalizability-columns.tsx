"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import { getBadgeClass, getLevelSortValue } from "./shared/table-view-styles";
import type { SafetyApproach, ApproachDependency } from "@data/tables/safety-generalizability";

// Re-export types
export type { SafetyApproach, ApproachDependency } from "@data/tables/safety-generalizability";

// Generalization level badge (pill style)
function GeneralizationBadge({ level }: { level: SafetyApproach["generalizationLevel"] }) {
  return (
    <span
      className={cn(
        "inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase",
        getBadgeClass(level, "generalization"),
      )}
    >
      {level}
    </span>
  );
}

// Sort value for generalization levels
function getGeneralizationSortValue(level: SafetyApproach["generalizationLevel"]): number {
  return getLevelSortValue(level);
}

// Dependencies/Threats list cell
function DependencyList({
  items,
  type,
}: {
  items: ApproachDependency[];
  type: "requires" | "threatens";
}) {
  if (items.length === 0) {
    return (
      <span className="text-muted-foreground italic text-[13px]">
        {type === "requires" ? "Minimal dependencies" : "Few threats identified"}
      </span>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2 text-[13px]">
          <span
            className={cn(
              "w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[10px]",
              type === "requires"
                ? "bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200"
                : "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200"
            )}
          >
            {type === "requires" ? "\u2713" : "\u2717"}
          </span>
          <span className="text-foreground">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

// Column definitions
export const createSafetyGeneralizabilityColumns = (): ColumnDef<SafetyApproach>[] => [
  {
    accessorKey: "label",
    header: ({ column }) => (
      <SortableHeader column={column}>Safety Approach</SortableHeader>
    ),
    cell: ({ row }) => {
      const approach = row.original;
      return (
        <div className="min-w-[200px]">
          <div className="font-semibold text-foreground">{approach.label}</div>
          {approach.description && (
            <div className="text-[13px] text-muted-foreground mt-1 line-clamp-2">
              {approach.description}
            </div>
          )}
          {approach.examples && (
            <div className="text-[13px] text-muted-foreground mt-1 italic">
              {approach.examples}
            </div>
          )}
        </div>
      );
    },
    enablePinning: true,
  },
  {
    id: "generalizationLevel",
    accessorFn: (row) => row.generalizationLevel,
    header: ({ column }) => (
      <SortableHeader column={column} title="Expected generalization to future AI architectures">
        Generalization
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <GeneralizationBadge level={row.original.generalizationLevel} />
    ),
    sortingFn: (rowA, rowB) => {
      const a = getGeneralizationSortValue(rowA.original.generalizationLevel);
      const b = getGeneralizationSortValue(rowB.original.generalizationLevel);
      return a - b;
    },
  },
  {
    id: "dependencies",
    accessorKey: "dependencies",
    header: () => <span className="text-xs">Requires (to work)</span>,
    cell: ({ row }) => (
      <DependencyList items={row.original.dependencies} type="requires" />
    ),
    enableSorting: false,
  },
  {
    id: "threats",
    accessorKey: "threats",
    header: () => <span className="text-xs">Threatened by</span>,
    cell: ({ row }) => (
      <DependencyList items={row.original.threats} type="threatens" />
    ),
    enableSorting: false,
  },
];

// Column config for visibility toggles
export const SAFETY_GENERALIZABILITY_COLUMNS = {
  generalizationLevel: {
    key: "generalizationLevel",
    label: "Generalization",
    group: "overview" as const,
    default: true,
  },
  dependencies: {
    key: "dependencies",
    label: "Requirements",
    group: "overview" as const,
    default: true,
  },
  threats: {
    key: "threats",
    label: "Threats",
    group: "overview" as const,
    default: true,
  },
} as const;

export type SafetyGeneralizabilityColumnKey = keyof typeof SAFETY_GENERALIZABILITY_COLUMNS;

export const SAFETY_GENERALIZABILITY_PRESETS = {
  all: Object.keys(SAFETY_GENERALIZABILITY_COLUMNS) as SafetyGeneralizabilityColumnKey[],
  compact: ["generalizationLevel"] as SafetyGeneralizabilityColumnKey[],
  default: Object.entries(SAFETY_GENERALIZABILITY_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as SafetyGeneralizabilityColumnKey[],
};
