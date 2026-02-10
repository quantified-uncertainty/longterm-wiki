"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import { getBadgeClass, getLevelSortValue } from "./shared/table-view-styles";

// Re-export types from data file
export type { RiskCoverage, EvalType, EvalCategory } from "@data/tables/eval-types";
import type { RiskCoverage, EvalType } from "@data/tables/eval-types";

// Badge component
function LevelBadge({ level, category }: { level: string; category?: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
        getBadgeClass(level, category)
      )}
    >
      {level}
    </span>
  );
}

function TimingBadge({ when }: { when: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200">
      {when}
    </span>
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

function RiskCoverageCell({ risks }: { risks: RiskCoverage[] }) {
  return (
    <div className="text-[11px] space-y-0.5">
      {risks.map((r, i) => (
        <div key={i} className="flex items-start gap-1">
          <span
            className={cn(
              "flex-shrink-0",
              r.strength === "strong"
                ? "text-green-700 dark:text-green-400"
                : r.strength === "partial"
                ? "text-amber-600 dark:text-amber-400"
                : "text-red-600 dark:text-red-400"
            )}
          >
            {r.strength === "strong" ? "●" : r.strength === "partial" ? "◐" : "○"}
          </span>
          <span>
            <strong className="text-foreground">{r.risk}</strong>
            {r.note && (
              <span className="text-muted-foreground text-[10px]"> - {r.note}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function LabsCell({ labs }: { labs: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {labs.slice(0, 4).map((lab) => (
        <span
          key={lab}
          className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
        >
          {lab}
        </span>
      ))}
      {labs.length > 4 && (
        <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
          +{labs.length - 4}
        </span>
      )}
    </div>
  );
}

function KeyPapersCell({ papers, examples }: { papers: string[]; examples: string[] }) {
  return (
    <div className="text-[10px] space-y-0.5">
      {papers.slice(0, 2).map((paper) => (
        <div key={paper} className="text-foreground">{paper}</div>
      ))}
      {examples.slice(0, 2).map((ex) => (
        <div key={ex} className="text-muted-foreground">{ex}</div>
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
export const createEvalTypesColumns = (): ColumnDef<EvalType>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Evaluation Type</SortableHeader>,
    cell: ({ row }) => {
      const ev = row.original;
      return (
        <div className="min-w-[200px]">
          <div className="font-semibold text-[13px] text-foreground">
            {ev.name}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 max-w-[220px]">
            {ev.description}
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
    id: "signalReliability",
    accessorFn: (row) => row.signalReliability.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How reliable is the signal?">
        Signal
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.signalReliability.level} />
        <CellNote note={row.original.signalReliability.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.signalReliability.level);
      const b = getLevelSortValue(rowB.original.signalReliability.level);
      return a - b;
    },
  },
  {
    id: "coverageDepth",
    accessorFn: (row) => row.coverageDepth.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How much does it cover?">
        Coverage
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.coverageDepth.level} />
        <CellNote note={row.original.coverageDepth.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.coverageDepth.level);
      const b = getLevelSortValue(rowB.original.coverageDepth.level);
      return a - b;
    },
  },
  {
    id: "goodhartRisk",
    accessorFn: (row) => row.goodhartRisk.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Risk of gaming the metric">
        Goodhart Risk
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.goodhartRisk.level} />
        <CellNote note={row.original.goodhartRisk.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.goodhartRisk.level);
      const b = getLevelSortValue(rowB.original.goodhartRisk.level);
      return a - b;
    },
  },
  {
    id: "riskCoverage",
    accessorKey: "riskCoverage",
    header: () => <span className="text-xs">Risk Coverage</span>,
    cell: ({ row }) => <RiskCoverageCell risks={row.original.riskCoverage} />,
    enableSorting: false,
  },
  {
    id: "timing",
    accessorFn: (row) => row.timing.when,
    header: ({ column }) => <SortableHeader column={column}>Timing</SortableHeader>,
    cell: ({ row }) => (
      <div>
        <TimingBadge when={row.original.timing.when} />
        <CellNote note={row.original.timing.note} />
      </div>
    ),
  },
  {
    id: "archDependence",
    accessorFn: (row) => row.archDependence.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Architecture dependence">
        Arch. Dep.
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.archDependence.level} />
        <CellNote note={row.original.archDependence.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.archDependence.level);
      const b = getLevelSortValue(rowB.original.archDependence.level);
      return a - b;
    },
  },
  {
    id: "actionability",
    accessorFn: (row) => row.actionability.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How actionable are findings?">
        Actionability
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.actionability.level} />
        <CellNote note={row.original.actionability.note} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.actionability.level);
      const b = getLevelSortValue(rowB.original.actionability.level);
      return a - b;
    },
  },
  {
    id: "scalability",
    accessorFn: (row) => row.scalability.level,
    header: ({ column }) => <SortableHeader column={column}>Scalability</SortableHeader>,
    cell: ({ row }) => (
      <div>
        <LevelBadge level={row.original.scalability.level} />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.scalability.level);
      const b = getLevelSortValue(rowB.original.scalability.level);
      return a - b;
    },
  },
  {
    id: "labs",
    accessorKey: "labs",
    header: () => <span className="text-xs">Labs</span>,
    cell: ({ row }) => <LabsCell labs={row.original.labs} />,
    enableSorting: false,
  },
  {
    id: "keyPapers",
    accessorKey: "keyPapers",
    header: () => <span className="text-xs">Key Papers/Examples</span>,
    cell: ({ row }) => (
      <KeyPapersCell papers={row.original.keyPapers} examples={row.original.examples} />
    ),
    enableSorting: false,
  },
  {
    id: "strategicPros",
    accessorKey: "strategicPros",
    header: () => <span className="text-xs">Strategic Pros</span>,
    cell: ({ row }) => <ProsCons items={row.original.strategicPros} type="pro" />,
    enableSorting: false,
  },
  {
    id: "strategicCons",
    accessorKey: "strategicCons",
    header: () => <span className="text-xs">Strategic Cons</span>,
    cell: ({ row }) => <ProsCons items={row.original.strategicCons} type="con" />,
    enableSorting: false,
  },
];

// Column config for visibility toggles
export const EVAL_TYPES_COLUMNS = {
  category: { key: "category", label: "Category", group: "overview" as const, default: false },
  signalReliability: { key: "signalReliability", label: "Signal Reliability", group: "signal" as const, default: true },
  coverageDepth: { key: "coverageDepth", label: "Coverage Depth", group: "signal" as const, default: true },
  goodhartRisk: { key: "goodhartRisk", label: "Goodhart Risk", group: "signal" as const, default: true },
  riskCoverage: { key: "riskCoverage", label: "Risk Coverage", group: "risk" as const, default: true },
  timing: { key: "timing", label: "Timing", group: "strategy" as const, default: true },
  archDependence: { key: "archDependence", label: "Arch. Dependence", group: "strategy" as const, default: true },
  actionability: { key: "actionability", label: "Actionability", group: "strategy" as const, default: true },
  scalability: { key: "scalability", label: "Scalability", group: "strategy" as const, default: true },
  labs: { key: "labs", label: "Labs", group: "landscape" as const, default: true },
  keyPapers: { key: "keyPapers", label: "Key Papers", group: "landscape" as const, default: true },
  strategicPros: { key: "strategicPros", label: "Strategic Pros", group: "assessment" as const, default: true },
  strategicCons: { key: "strategicCons", label: "Strategic Cons", group: "assessment" as const, default: true },
} as const;

export type EvalTypesColumnKey = keyof typeof EVAL_TYPES_COLUMNS;

export const EVAL_TYPES_PRESETS = {
  all: Object.keys(EVAL_TYPES_COLUMNS) as EvalTypesColumnKey[],
  signal: [
    "signalReliability",
    "coverageDepth",
    "goodhartRisk",
    "riskCoverage",
  ] as EvalTypesColumnKey[],
  strategy: [
    "timing",
    "archDependence",
    "actionability",
    "scalability",
  ] as EvalTypesColumnKey[],
  compact: [
    "signalReliability",
    "goodhartRisk",
    "riskCoverage",
    "actionability",
    "scalability",
  ] as EvalTypesColumnKey[],
  default: Object.entries(EVAL_TYPES_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as EvalTypesColumnKey[],
};
