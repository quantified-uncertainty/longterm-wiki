"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  getLevelSortValue,
} from "./shared/table-view-styles";
import { LevelBadge, CellNote, SafetyOutlookBadge } from "./shared/cell-components";
import { levelNoteColumn, prosConsColumns } from "./shared/column-helpers";
import type { Architecture, SafetyOutlook, Category, Source } from "@data/tables/ai-architectures";

export type { SafetyOutlook, Category, Source, Architecture } from "@data/tables/ai-architectures";

function TimelineBadge({ timeline }: { timeline: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200">
      {timeline}
    </span>
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
        <LevelBadge level={row.original.adoption} category="adoption" />
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
  levelNoteColumn<Architecture>({ id: "agencyLevel", accessor: (r) => r.agencyLevel, label: "Agency Level", tooltip: "Level of autonomous decision-making" }),
  levelNoteColumn<Architecture>({ id: "decomposition", accessor: (r) => r.decomposition, label: "Decomposition", tooltip: "How tasks are broken down" }),
  levelNoteColumn<Architecture>({ id: "oversight", accessor: (r) => r.oversight, label: "Oversight", tooltip: "Human oversight mechanism" }),
  levelNoteColumn<Architecture>({ id: "whitebox", accessor: (r) => r.whitebox, label: "White-box", tooltip: "Interpretability of internals" }),
  levelNoteColumn<Architecture>({ id: "modularity", accessor: (r) => r.modularity, label: "Modularity", tooltip: "Component separation" }),
  levelNoteColumn<Architecture>({ id: "verifiable", accessor: (r) => r.verifiable, label: "Verifiable", tooltip: "Formal verification possible" }),
  {
    id: "sources",
    accessorKey: "sources",
    header: () => <span className="text-xs">Key Sources</span>,
    cell: ({ row }) => <SourcesCell sources={row.original.sources} />,
    enableSorting: false,
  },
  ...prosConsColumns<Architecture>({
    prosId: "safetyPros",
    consId: "safetyCons",
    prosField: (r) => r.safetyPros,
    consField: (r) => r.safetyCons,
  }),
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
