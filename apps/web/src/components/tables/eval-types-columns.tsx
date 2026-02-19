"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import { getLevelSortValue } from "./shared/table-view-styles";
import { LevelBadge, CellNote } from "./shared/cell-components";
import { levelNoteColumn, prosConsColumns } from "./shared/column-helpers";

// Re-export types from data file
export type { RiskCoverage, EvalType, EvalCategory } from "@data/tables/eval-types";
import type { RiskCoverage, EvalType } from "@data/tables/eval-types";

function TimingBadge({ when }: { when: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200">
      {when}
    </span>
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
            {r.strength === "strong" ? "\u25CF" : r.strength === "partial" ? "\u25D0" : "\u25CB"}
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
  levelNoteColumn<EvalType>({ id: "signalReliability", accessor: (r) => r.signalReliability, label: "Signal", tooltip: "How reliable is the signal?" }),
  levelNoteColumn<EvalType>({ id: "coverageDepth", accessor: (r) => r.coverageDepth, label: "Coverage", tooltip: "How much does it cover?" }),
  levelNoteColumn<EvalType>({ id: "goodhartRisk", accessor: (r) => r.goodhartRisk, label: "Goodhart Risk", tooltip: "Risk of gaming the metric" }),
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
  levelNoteColumn<EvalType>({ id: "archDependence", accessor: (r) => r.archDependence, label: "Arch. Dep.", tooltip: "Architecture dependence" }),
  levelNoteColumn<EvalType>({ id: "actionability", accessor: (r) => r.actionability, label: "Actionability", tooltip: "How actionable are findings?" }),
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
  ...prosConsColumns<EvalType>({
    prosId: "strategicPros",
    consId: "strategicCons",
    prosField: (r) => r.strategicPros,
    consField: (r) => r.strategicCons,
    prosLabel: "Strategic Pros",
    consLabel: "Strategic Cons",
  }),
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
