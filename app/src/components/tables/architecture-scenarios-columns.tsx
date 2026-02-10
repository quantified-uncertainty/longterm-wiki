"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  getBadgeClass,
  getSafetyOutlookClass,
  getLevelSortValue,
  categoryColors,
} from "./shared/table-view-styles";

// Re-export types from data file
export type {
  SafetyOutlook,
  Category,
  Link,
  LabLink,
  Scenario,
} from "@data/tables/architecture-scenarios";

// Import types for use in this file
import type {
  SafetyOutlook,
  Category,
  Scenario,
  LabLink,
  Link,
} from "@data/tables/architecture-scenarios";

// Re-export CATEGORIES from data file
export { CATEGORIES } from "@data/tables/architecture-scenarios";

// Sparkline data (illustrative research activity over time)
export const SPARKLINE_DATA: Record<string, number[]> = {
  "minimal-scaffolding": [80, 85, 70, 50, 35, 25, 20],
  "light-scaffolding": [20, 40, 60, 75, 80, 75, 70],
  "heavy-scaffolding": [5, 10, 20, 40, 70, 90, 95],
  "dense-transformers": [70, 80, 85, 90, 85, 80, 75],
  "sparse-moe": [10, 20, 35, 50, 70, 85, 95],
  "ssm-hybrid": [0, 5, 15, 40, 60, 70, 75],
  "world-model-planning": [15, 20, 30, 40, 50, 60, 65],
  "hybrid-neurosymbolic": [25, 28, 32, 35, 40, 50, 55],
  "provable-bounded": [5, 8, 12, 18, 25, 35, 45],
  "biological-organic": [8, 10, 12, 15, 18, 22, 28],
  "neuromorphic": [20, 22, 25, 28, 32, 36, 40],
  "whole-brain-emulation": [15, 14, 13, 12, 12, 11, 10],
  "genetic-enhancement": [10, 12, 15, 18, 20, 22, 25],
  "bci-enhancement": [10, 15, 25, 35, 50, 60, 70],
  "collective-intelligence": [20, 25, 30, 40, 55, 70, 80],
  "novel-unknown": [10, 10, 10, 10, 10, 10, 10],
};

// Import CATEGORIES for use in this file
import { CATEGORIES } from "@data/tables/architecture-scenarios";

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

function LikelihoodBadge({ likelihood }: { likelihood: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100">
      {likelihood}
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
                : rating === "challenging"
                  ? "text-red-700 dark:text-red-400"
                  : "text-muted-foreground"
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

// Category cell with color dot
function CategoryCell({ category }: { category: Category }) {
  const colors = categoryColors[category] || categoryColors.deployment;
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn("w-2 h-2 rounded-full shrink-0", colors.dot)} />
      <span className={cn("text-[10px]", colors.text)}>
        {CATEGORIES[category].label}
      </span>
    </div>
  );
}

// Sparkline component
function Sparkline({ data, label }: { data: number[]; label?: string }) {
  const max = Math.max(...data);
  return (
    <div>
      <div className="flex items-end gap-0.5 h-7">
        {data.map((val, i) => (
          <div
            key={i}
            className="w-2 bg-blue-500 rounded-t transition-[height]"
            style={{
              height: `${(val / max) * 24}px`,
              opacity: 0.4 + (i / data.length) * 0.6,
            }}
            title={`${2020 + i}: ${val}%`}
          />
        ))}
      </div>
      {label && (
        <div className="text-[9px] text-muted-foreground mt-0.5">{label}</div>
      )}
    </div>
  );
}

// Labs cell
function LabsCell({ labs }: { labs: LabLink[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {labs.map((lab, i) => (
        <span
          key={lab.name || i}
          className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
        >
          {lab.url ? (
            <a
              href={lab.url}
              className="text-inherit hover:underline"
            >
              {lab.name}
            </a>
          ) : (
            lab.name
          )}
        </span>
      ))}
    </div>
  );
}

// Papers cell
function PapersCell({ papers }: { papers: Link[] }) {
  if (!papers || papers.length === 0) {
    return <span className="text-[10px] text-muted-foreground italic">None listed</span>;
  }
  return (
    <div className="text-[10px] space-y-0.5">
      {papers.map((paper, i) => (
        <div key={paper.title || i}>
          {paper.url ? (
            <a
              href={paper.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {paper.title}
            </a>
          ) : (
            <span className="text-muted-foreground">{paper.title}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// Pros/Cons list
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

// Key risks/opportunities list
function RiskOpportunityList({ items, type }: { items: string[]; type: "risk" | "opportunity" }) {
  const colorClass =
    type === "risk"
      ? "text-red-700 dark:text-red-400"
      : "text-green-700 dark:text-green-400";

  return (
    <div className="text-[11px] space-y-0.5">
      {items.map((item) => (
        <div key={item} className={colorClass}>
          • {item}
        </div>
      ))}
    </div>
  );
}

// Sorting helpers
const SAFETY_ORDER: Record<SafetyOutlook, number> = {
  favorable: 4,
  mixed: 3,
  challenging: 2,
  unknown: 1,
};

const CATEGORY_ORDER: Record<Category, number> = {
  deployment: 1,
  "base-arch": 2,
  "alt-compute": 3,
  "non-ai": 4,
};

// Create columns
export const createArchitectureScenariosColumns = (): ColumnDef<Scenario>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Scenario</SortableHeader>,
    cell: ({ row }) => {
      const scenario = row.original;
      return (
        <div className="min-w-[160px]">
          <div className="font-semibold text-xs">
            {scenario.pageUrl ? (
              <a
                href={scenario.pageUrl}
                className="text-foreground hover:text-primary border-b border-dotted border-primary/50"
              >
                {scenario.name}
              </a>
            ) : (
              <span className="text-foreground">{scenario.name}</span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2 max-w-[180px]">
            {scenario.description}
          </div>
        </div>
      );
    },
    enablePinning: true,
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
    cell: ({ row }) => <CategoryCell category={row.getValue("category")} />,
    sortingFn: (rowA, rowB) => {
      const a = CATEGORY_ORDER[rowA.getValue("category") as Category] ?? 99;
      const b = CATEGORY_ORDER[rowB.getValue("category") as Category] ?? 99;
      return a - b;
    },
  },
  {
    id: "likelihood",
    accessorFn: (row) => row.likelihood,
    header: ({ column }) => (
      <SortableHeader column={column} title="Probability this becomes dominant at TAI">
        P(dominant at TAI)
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LikelihoodBadge likelihood={row.original.likelihood} />
        <CellNote note={row.original.likelihoodNote} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const aNum = parseFloat(rowA.original.likelihood.replace(/[^0-9.]/g, "")) || 0;
      const bNum = parseFloat(rowB.original.likelihood.replace(/[^0-9.]/g, "")) || 0;
      return aNum - bNum;
    },
  },
  {
    id: "trend",
    accessorFn: (row) => row.id,
    header: () => <span className="text-xs">Trend</span>,
    cell: ({ row }) => {
      const data = SPARKLINE_DATA[row.original.id];
      if (!data) {
        return <span className="text-[11px] text-muted-foreground">No data</span>;
      }
      return <Sparkline data={data} label="(illustrative)" />;
    },
    enableSorting: false,
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
      const a = rowA.original.safetyOutlook.score ?? SAFETY_ORDER[rowA.original.safetyOutlook.rating] * 2;
      const b = rowB.original.safetyOutlook.score ?? SAFETY_ORDER[rowB.original.safetyOutlook.rating] * 2;
      return a - b;
    },
  },
  {
    id: "keyRisks",
    accessorKey: "safetyOutlook",
    header: () => <span className="text-xs">Key Risks</span>,
    cell: ({ row }) => (
      <RiskOpportunityList items={row.original.safetyOutlook.keyRisks} type="risk" />
    ),
    enableSorting: false,
  },
  {
    id: "keyOpportunities",
    accessorKey: "safetyOutlook",
    header: () => <span className="text-xs">Key Opportunities</span>,
    cell: ({ row }) => (
      <RiskOpportunityList items={row.original.safetyOutlook.keyOpportunities} type="opportunity" />
    ),
    enableSorting: false,
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
    id: "training",
    accessorFn: (row) => row.training.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Training approach">
        Trainable
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.training.level} />
        <CellNote note={row.original.training.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.training.level);
      const b = getLevelSortValue(rowB.original.training.level);
      return a - b;
    },
  },
  {
    id: "predictability",
    accessorFn: (row) => row.predictability.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Behavior predictability">
        Predictable
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.predictability.level} />
        <CellNote note={row.original.predictability.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.predictability.level);
      const b = getLevelSortValue(rowB.original.predictability.level);
      return a - b;
    },
  },
  {
    id: "modularity",
    accessorFn: (row) => row.modularity.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Component separation">
        Modular
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
    accessorFn: (row) => row.formalVerifiable.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Formal verification possible">
        Verifiable
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.formalVerifiable.level} />
        <CellNote note={row.original.formalVerifiable.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.formalVerifiable.level);
      const b = getLevelSortValue(rowB.original.formalVerifiable.level);
      return a - b;
    },
  },
  {
    id: "tractability",
    accessorFn: (row) => row.researchTractability.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Research tractability">
        Research Tractability
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.researchTractability.level} />
        <CellNote note={row.original.researchTractability.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.researchTractability.level);
      const b = getLevelSortValue(rowB.original.researchTractability.level);
      return a - b;
    },
  },
  {
    id: "keyPapers",
    accessorKey: "keyPapers",
    header: () => <span className="text-xs">Key Papers</span>,
    cell: ({ row }) => <PapersCell papers={row.original.keyPapers} />,
    enableSorting: false,
  },
  {
    id: "labs",
    accessorKey: "labs",
    header: () => <span className="text-xs">Labs</span>,
    cell: ({ row }) => <LabsCell labs={row.original.labs} />,
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
export const ARCHITECTURE_COLUMNS = {
  likelihood: { key: "likelihood", label: "P(TAI)", group: "overview" as const, default: true },
  trend: { key: "trend", label: "Trend", group: "overview" as const, default: true },
  safetyOutlook: { key: "safetyOutlook", label: "Safety Outlook", group: "safety" as const, default: true },
  keyRisks: { key: "keyRisks", label: "Key Risks", group: "safety" as const, default: false },
  keyOpportunities: { key: "keyOpportunities", label: "Key Opportunities", group: "safety" as const, default: false },
  whitebox: { key: "whitebox", label: "White-box", group: "safety" as const, default: true },
  training: { key: "training", label: "Trainable", group: "safety" as const, default: true },
  predictability: { key: "predictability", label: "Predictable", group: "safety" as const, default: true },
  modularity: { key: "modularity", label: "Modular", group: "safety" as const, default: true },
  verifiable: { key: "verifiable", label: "Verifiable", group: "safety" as const, default: true },
  tractability: { key: "tractability", label: "Research Tractability", group: "safety" as const, default: false },
  keyPapers: { key: "keyPapers", label: "Key Papers", group: "landscape" as const, default: true },
  labs: { key: "labs", label: "Labs", group: "landscape" as const, default: true },
  safetyPros: { key: "safetyPros", label: "Safety Pros", group: "assessment" as const, default: true },
  safetyCons: { key: "safetyCons", label: "Safety Cons", group: "assessment" as const, default: true },
} as const;

export type ArchitectureColumnKey = keyof typeof ARCHITECTURE_COLUMNS;

export const ARCHITECTURE_PRESETS = {
  all: Object.keys(ARCHITECTURE_COLUMNS) as ArchitectureColumnKey[],
  safety: [
    "safetyOutlook",
    "keyRisks",
    "keyOpportunities",
    "whitebox",
    "training",
    "predictability",
    "modularity",
    "verifiable",
    "tractability",
  ] as ArchitectureColumnKey[],
  compact: [
    "likelihood",
    "safetyOutlook",
    "whitebox",
    "predictability",
    "verifiable",
  ] as ArchitectureColumnKey[],
  default: Object.entries(ARCHITECTURE_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as ArchitectureColumnKey[],
};
