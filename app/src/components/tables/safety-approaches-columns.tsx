"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { SortableHeader } from "@/components/ui/sortable-header"
import { cn } from "@/lib/utils"
import type { SafetyApproach } from "@data/tables/safety-approaches"
import {
  getArchRelevanceClass,
  safetyCategorySortOrder,
  safetyCategoryColors,
} from "./shared/table-view-styles"
import { levelNoteColumn } from "./shared/column-helpers"

// Architecture relevance badge (abbreviated)
function ArchBadge({ level }: { level: string }) {
  const shortLevel = level === "NOT_APPLICABLE" ? "N/A" : level.charAt(0)
  return (
    <span
      className={cn("inline-block px-1 py-0.5 rounded text-[9px] font-semibold", getArchRelevanceClass(level))}
      title={level}
    >
      {shortLevel}
    </span>
  )
}

// Format architecture ID to short name
const archNames: Record<string, string> = {
  "scaled-transformers": "Transformers",
  "scaffolded-agents": "Agents",
  "ssm-based": "SSMs",
  "hybrid-neurosymbolic": "Neuro-Sym",
  "novel-unknown": "Novel",
}

// Category labels
const categoryLabels: Record<string, string> = {
  training: "Training & Alignment",
  interpretability: "Interpretability",
  evaluation: "Evaluation",
  architectural: "Architectural",
  governance: "Governance",
  theoretical: "Theoretical",
}

export function createSafetyApproachesColumns(): ColumnDef<SafetyApproach>[] {
  return [
    // Sticky name column
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Approach</SortableHeader>,
      cell: ({ row }) => {
        const approach = row.original
        const detailUrl = `/knowledge-base/responses/safety-approaches/${approach.id}/`
        return (
          <div className="min-w-[140px]" title={approach.description}>
            <a
              href={detailUrl}
              className="font-semibold text-xs text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
            >
              {approach.name}
            </a>
          </div>
        )
      },
      enablePinning: true,
    },
    {
      accessorKey: "category",
      header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
      cell: ({ row }) => {
        const category = row.getValue<string>("category")
        const colors = safetyCategoryColors[category] || safetyCategoryColors.training
        return (
          <div className="flex items-center gap-1.5">
            <div className={cn("w-2 h-2 rounded-full shrink-0", colors.dot)} />
            <span className="text-[10px] text-foreground">
              {categoryLabels[category] || category}
            </span>
          </div>
        )
      },
      sortingFn: (rowA, rowB) => {
        const a = safetyCategorySortOrder[rowA.getValue("category") as string] ?? 99
        const b = safetyCategorySortOrder[rowB.getValue("category") as string] ?? 99
        return a - b
      },
    },
    {
      id: "investment",
      accessorFn: (row) => row.researchInvestment.amount,
      header: ({ column }) => (
        <SortableHeader column={column} title="Current research investment">
          Investment
        </SortableHeader>
      ),
      cell: ({ row }) => {
        const inv = row.original.researchInvestment
        return (
          <div title={inv.note || undefined}>
            <span className="text-[10px] font-semibold text-foreground">{inv.amount}</span>
          </div>
        )
      },
    },
    levelNoteColumn<SafetyApproach>({ id: "differential", accessor: (r) => r.differentialProgress, label: "Differential", tooltip: "Safety vs capability progress ratio", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "recommendation", accessor: (r) => r.recommendation, label: "Recommend", tooltip: "Recommended funding change", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "safetyUplift", accessor: (r) => r.safetyUplift, label: "Safety Uplift", tooltip: "How much does this reduce catastrophic risk?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "capabilityUplift", accessor: (r) => r.capabilityUplift, label: "Cap Uplift", tooltip: "Does it make AI more capable?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "netSafety", accessor: (r) => r.netWorldSafety, label: "Net Safety", tooltip: "Is the world safer with this?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "scalability", accessor: (r) => r.scalability, label: "Scalability", tooltip: "Does it work as AI gets smarter?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "deception", accessor: (r) => r.deceptionRobust, label: "Deception", tooltip: "Does it work against deceptive AI?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "siReady", accessor: (r) => r.siReady, label: "SI Ready", tooltip: "Works for superintelligent AI?", noteStyle: "tooltip" }),
    levelNoteColumn<SafetyApproach>({ id: "adoption", accessor: (r) => r.currentAdoption, label: "Adoption", tooltip: "Current adoption level", noteStyle: "tooltip" }),
    {
      accessorKey: "keyLabs",
      header: () => <span className="text-xs">Labs</span>,
      cell: ({ row }) => {
        const labs = row.getValue<string[]>("keyLabs")
        return (
          <div className="flex flex-wrap gap-1">
            {labs.slice(0, 4).map((lab) => (
              <span
                key={lab}
                className="text-[9px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded"
              >
                {lab}
              </span>
            ))}
          </div>
        )
      },
      enableSorting: false,
    },
    {
      accessorKey: "mainCritiques",
      header: () => <span className="text-xs">Critiques</span>,
      cell: ({ row }) => {
        const critiques = row.getValue<string[]>("mainCritiques")
        if (critiques.length === 0) return null
        return (
          <div className="text-[10px] text-muted-foreground min-w-[160px] space-y-0.5">
            {critiques.map((c, i) => (
              <div key={i} className="leading-tight">{"\u2022"} {c}</div>
            ))}
          </div>
        )
      },
      enableSorting: false,
    },
    {
      accessorKey: "architectureRelevance",
      header: () => (
        <a
          href="/knowledge-base/architecture-scenarios/table"
          className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Architectures
        </a>
      ),
      cell: ({ row }) => {
        const archRel = row.original.architectureRelevance
        if (!archRel || archRel.length === 0) {
          return <span className="text-[9px] text-muted-foreground">&mdash;</span>
        }
        return (
          <div className="flex flex-col gap-0.5">
            {archRel.slice(0, 3).map((arch) => (
              <div key={arch.architectureId} className="flex items-center gap-1">
                <ArchBadge level={arch.relevance} />
                <span className="text-[8px] text-muted-foreground">
                  {archNames[arch.architectureId] || arch.architectureId}
                </span>
              </div>
            ))}
          </div>
        )
      },
      enableSorting: false,
    },
  ]
}

// Column config for visibility toggles
export const SAFETY_APPROACHES_COLUMNS = {
  category: { key: "category", label: "Category", group: "overview" as const, default: true },
  investment: { key: "investment", label: "Investment", group: "landscape" as const, default: true },
  differential: { key: "differential", label: "Differential", group: "safety" as const, default: true },
  recommendation: { key: "recommendation", label: "Recommend", group: "strategy" as const, default: true },
  safetyUplift: { key: "safetyUplift", label: "Safety Uplift", group: "safety" as const, default: true },
  capabilityUplift: { key: "capabilityUplift", label: "Cap Uplift", group: "safety" as const, default: true },
  netSafety: { key: "netSafety", label: "Net Safety", group: "safety" as const, default: true },
  scalability: { key: "scalability", label: "Scalability", group: "assessment" as const, default: true },
  deception: { key: "deception", label: "Deception", group: "assessment" as const, default: true },
  siReady: { key: "siReady", label: "SI Ready", group: "assessment" as const, default: true },
  adoption: { key: "adoption", label: "Adoption", group: "landscape" as const, default: true },
  keyLabs: { key: "keyLabs", label: "Labs", group: "landscape" as const, default: false },
  mainCritiques: { key: "mainCritiques", label: "Critiques", group: "assessment" as const, default: false },
  architectureRelevance: { key: "architectureRelevance", label: "Architectures", group: "overview" as const, default: false },
} as const;

export type SafetyApproachesColumnKey = keyof typeof SAFETY_APPROACHES_COLUMNS;

export const SAFETY_APPROACHES_PRESETS = {
  default: Object.entries(SAFETY_APPROACHES_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as SafetyApproachesColumnKey[],
  all: Object.keys(SAFETY_APPROACHES_COLUMNS) as SafetyApproachesColumnKey[],
  safety: [
    "category",
    "safetyUplift",
    "capabilityUplift",
    "netSafety",
    "differential",
    "recommendation",
  ] as SafetyApproachesColumnKey[],
  compact: [
    "category",
    "safetyUplift",
    "netSafety",
    "scalability",
    "recommendation",
  ] as SafetyApproachesColumnKey[],
};
