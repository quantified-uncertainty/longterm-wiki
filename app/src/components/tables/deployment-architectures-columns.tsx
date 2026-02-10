"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  getBadgeClass,
  getSafetyOutlookClass,
  getLevelSortValue,
} from "./shared/table-view-styles";
import type { Architecture, SafetyOutlook, Category, Source } from "@data/tables/ai-architectures";

export type { SafetyOutlook, Category, Source, Architecture } from "@data/tables/ai-architectures";

// Badge components
function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
        getBadgeClass(level)
      )}
    >
      {level}
    </span>
  );
}

function AdoptionBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
        getBadgeClass(level, "adoption")
      )}
    >
      {level}
    </span>
  );
}

function TimelineBadge({ timeline }: { timeline: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200">
      {timeline}
    </span>
  );
}

function SafetyOutlookBadge({
  rating,
  score,
}: {
  rating: SafetyOutlook;
  score?: number;
}) {
  const labels: Record<SafetyOutlook, string> = {
    favorable: "Favorable",
    mixed: "Mixed",
    challenging: "Challenging",
    unknown: "Unknown",
  };

  return (
    <div className="flex flex-col gap-1">
      {score !== undefined && (
        <div
          className={cn(
            "text-lg font-bold",
            rating === "favorable"
              ? "text-green-700 dark:text-green-400"
              : rating === "mixed"
                ? "text-amber-700 dark:text-amber-400"
                : "text-red-700 dark:text-red-400"
          )}
        >
          {score}/10
        </div>
      )}
      <span
        className={cn(
          "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
          getSafetyOutlookClass(rating)
        )}
      >
        {labels[rating]}
      </span>
    </div>
  );
}

function CellNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <div className="text-[9px] text-muted-foreground mt-1 line-clamp-2">
      {note}
    </div>
  );
}

function SourcesCell({ sources }: { sources: Source[] }) {
  return (
    <div className="text-[10px] space-y-0.5">
      {sources.map((src, i) => (
        <div key={i}>
          {src.url ? (
            <a
              href={src.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {src.title}
            </a>
          ) : (
            <span className="text-muted-foreground">{src.title}</span>
          )}
          {src.year && (
            <span className="text-muted-foreground/70 ml-1">({src.year})</span>
          )}
        </div>
      ))}
    </div>
  );
}

function ProsCons({ items, type }: { items: string[]; type: "pro" | "con" }) {
  const prefix = type === "pro" ? "+" : "−";
  const colorClass =
    type === "pro"
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400";

  return (
    <div className="text-[11px] space-y-0.5">
      {items.map((item) => (
        <div key={item} className={colorClass}>
          {prefix} {item}
        </div>
      ))}
    </div>
  );
}

// Column definitions
export const createDeploymentArchitecturesColumns = (): ColumnDef<Architecture>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Architecture</SortableHeader>,
    cell: ({ row }) => {
      const arch = row.original;
      return (
        <div className="min-w-[180px]">
          <div className="font-semibold text-xs text-foreground">
            {arch.name}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2 max-w-[200px]">
            {arch.description}
          </div>
        </div>
      );
    },
    enablePinning: true,
  },
  {
    id: "adoption",
    accessorFn: (row) => row.adoption,
    header: ({ column }) => (
      <SortableHeader column={column} title="Current adoption level">
        Adoption
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <AdoptionBadge level={row.original.adoption} />
        <CellNote note={row.original.adoptionNote} />
        <div className="mt-1">
          <TimelineBadge timeline={row.original.timeline} />
        </div>
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.adoption);
      const b = getLevelSortValue(rowB.original.adoption);
      return a - b;
    },
  },
  {
    id: "safetyOutlook",
    accessorFn: (row) => row.safetyOutlook.score ?? 0,
    header: ({ column }) => (
      <SortableHeader column={column} title="Overall safety assessment">
        Safety Outlook
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <SafetyOutlookBadge
          rating={row.original.safetyOutlook.rating}
          score={row.original.safetyOutlook.score}
        />
        <CellNote note={row.original.safetyOutlook.summary} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.safetyOutlook.score ?? getLevelSortValue(rowA.original.safetyOutlook.rating);
      const b = rowB.original.safetyOutlook.score ?? getLevelSortValue(rowB.original.safetyOutlook.rating);
      return a - b;
    },
  },
  {
    id: "agencyLevel",
    accessorFn: (row) => row.agencyLevel.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Level of autonomous decision-making">
        Agency Level
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.agencyLevel.level} />
        <CellNote note={row.original.agencyLevel.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.agencyLevel.level);
      const b = getLevelSortValue(rowB.original.agencyLevel.level);
      return a - b;
    },
  },
  {
    id: "decomposition",
    accessorFn: (row) => row.decomposition.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How tasks are broken down">
        Decomposition
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.decomposition.level} />
        <CellNote note={row.original.decomposition.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.decomposition.level);
      const b = getLevelSortValue(rowB.original.decomposition.level);
      return a - b;
    },
  },
  {
    id: "oversight",
    accessorFn: (row) => row.oversight.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Human oversight mechanism">
        Oversight
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.oversight.level} />
        <CellNote note={row.original.oversight.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.oversight.level);
      const b = getLevelSortValue(rowB.original.oversight.level);
      return a - b;
    },
  },
  {
    id: "whitebox",
    accessorFn: (row) => row.whitebox.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Interpretability of internals">
        White-box
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.whitebox.level} />
        <CellNote note={row.original.whitebox.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.whitebox.level);
      const b = getLevelSortValue(rowB.original.whitebox.level);
      return a - b;
    },
  },
  {
    id: "modularity",
    accessorFn: (row) => row.modularity.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Component separation">
        Modularity
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.modularity.level} />
        <CellNote note={row.original.modularity.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.modularity.level);
      const b = getLevelSortValue(rowB.original.modularity.level);
      return a - b;
    },
  },
  {
    id: "verifiable",
    accessorFn: (row) => row.verifiable.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Formal verification possible">
        Verifiable
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.verifiable.level} />
        <CellNote note={row.original.verifiable.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.verifiable.level);
      const b = getLevelSortValue(rowB.original.verifiable.level);
      return a - b;
    },
  },
  {
    id: "sources",
    accessorKey: "sources",
    header: () => <span className="text-xs">Key Sources</span>,
    cell: ({ row }) => <SourcesCell sources={row.original.sources} />,
    enableSorting: false,
  },
  {
    id: "safetyPros",
    accessorKey: "safetyPros",
    header: () => <span className="text-xs">Safety Pros</span>,
    cell: ({ row }) => <ProsCons items={row.original.safetyPros} type="pro" />,
    enableSorting: false,
  },
  {
    id: "safetyCons",
    accessorKey: "safetyCons",
    header: () => <span className="text-xs">Safety Cons</span>,
    cell: ({ row }) => <ProsCons items={row.original.safetyCons} type="con" />,
    enableSorting: false,
  },
];

// Column config for visibility toggles
export const DEPLOYMENT_COLUMNS = {
  adoption: { key: "adoption", label: "Adoption", group: "overview" as const, default: true },
  safetyOutlook: { key: "safetyOutlook", label: "Safety Outlook", group: "overview" as const, default: true },
  agencyLevel: { key: "agencyLevel", label: "Agency Level", group: "safety" as const, default: true },
  decomposition: { key: "decomposition", label: "Decomposition", group: "safety" as const, default: true },
  oversight: { key: "oversight", label: "Oversight", group: "safety" as const, default: true },
  whitebox: { key: "whitebox", label: "White-box", group: "safety" as const, default: true },
  modularity: { key: "modularity", label: "Modularity", group: "safety" as const, default: false },
  verifiable: { key: "verifiable", label: "Verifiable", group: "safety" as const, default: false },
  sources: { key: "sources", label: "Key Sources", group: "landscape" as const, default: true },
  safetyPros: { key: "safetyPros", label: "Safety Pros", group: "landscape" as const, default: true },
  safetyCons: { key: "safetyCons", label: "Safety Cons", group: "landscape" as const, default: true },
} as const;

export type DeploymentColumnKey = keyof typeof DEPLOYMENT_COLUMNS;

export const DEPLOYMENT_PRESETS = {
  all: Object.keys(DEPLOYMENT_COLUMNS) as DeploymentColumnKey[],
  safety: [
    "safetyOutlook",
    "agencyLevel",
    "decomposition",
    "oversight",
    "whitebox",
    "modularity",
    "verifiable",
  ] as DeploymentColumnKey[],
  compact: [
    "adoption",
    "safetyOutlook",
    "agencyLevel",
    "oversight",
    "whitebox",
  ] as DeploymentColumnKey[],
  default: Object.entries(DEPLOYMENT_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as DeploymentColumnKey[],
};

// Category data
export const CATEGORIES: Record<Category, { label: string; description: string }> = {
  basic: { label: "Basic Patterns", description: "Minimal to light scaffolding approaches" },
  structured: { label: "Structured Safety Architectures", description: "Architectures designed with safety properties" },
  oversight: { label: "Oversight Mechanisms", description: "Methods for supervising AI systems" },
};
