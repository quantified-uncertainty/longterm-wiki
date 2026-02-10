"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { SortableHeader } from "@/components/ui/sortable-header"
import { cn } from "@/lib/utils"
import type { SafetyApproach, RatedProperty } from "@data/tables/safety-approaches"
import {
  getBadgeColorClass,
  getArchRelevanceClass,
  getLevelSortValue,
  categorySortOrder,
  categoryColors,
} from "./shared/safety-table-styles"

// Render a badge with appropriate color
function LevelBadge({ level }: { level: string }) {
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
      getBadgeColorClass(level)
    )}>
      {level}
    </span>
  )
}

// Render a rated property (badge + note on hover)
function RatingCell({ rating }: { rating: RatedProperty }) {
  return (
    <div className="group relative" title={rating.note || undefined}>
      <LevelBadge level={rating.level} />
    </div>
  )
}

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

export const columns: ColumnDef<SafetyApproach>[] = [
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
      const colors = categoryColors[category] || categoryColors.training
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
      const a = categorySortOrder[rowA.getValue("category") as string] ?? 99
      const b = categorySortOrder[rowB.getValue("category") as string] ?? 99
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
  {
    id: "differential",
    accessorFn: (row) => row.differentialProgress.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Safety vs capability progress ratio">
        Differential
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.differentialProgress} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.differentialProgress.level)
      const b = getLevelSortValue(rowB.original.differentialProgress.level)
      return a - b
    },
  },
  {
    id: "recommendation",
    accessorFn: (row) => row.recommendation.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Recommended funding change">
        Recommend
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.recommendation} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.recommendation.level)
      const b = getLevelSortValue(rowB.original.recommendation.level)
      return a - b
    },
  },
  {
    id: "safetyUplift",
    accessorFn: (row) => row.safetyUplift.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="How much does this reduce catastrophic risk?">
        Safety Uplift
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.safetyUplift} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.safetyUplift.level)
      const b = getLevelSortValue(rowB.original.safetyUplift.level)
      return a - b
    },
  },
  {
    id: "capabilityUplift",
    accessorFn: (row) => row.capabilityUplift.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Does it make AI more capable?">
        Cap Uplift
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.capabilityUplift} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.capabilityUplift.level)
      const b = getLevelSortValue(rowB.original.capabilityUplift.level)
      return a - b
    },
  },
  {
    id: "netSafety",
    accessorFn: (row) => row.netWorldSafety.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Is the world safer with this?">
        Net Safety
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.netWorldSafety} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.netWorldSafety.level)
      const b = getLevelSortValue(rowB.original.netWorldSafety.level)
      return a - b
    },
  },
  {
    id: "scalability",
    accessorFn: (row) => row.scalability.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Does it work as AI gets smarter?">
        Scalability
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.scalability} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.scalability.level)
      const b = getLevelSortValue(rowB.original.scalability.level)
      return a - b
    },
  },
  {
    id: "deception",
    accessorFn: (row) => row.deceptionRobust.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Does it work against deceptive AI?">
        Deception
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.deceptionRobust} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.deceptionRobust.level)
      const b = getLevelSortValue(rowB.original.deceptionRobust.level)
      return a - b
    },
  },
  {
    id: "siReady",
    accessorFn: (row) => row.siReady.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Works for superintelligent AI?">
        SI Ready
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.siReady} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.siReady.level)
      const b = getLevelSortValue(rowB.original.siReady.level)
      return a - b
    },
  },
  {
    id: "adoption",
    accessorFn: (row) => row.currentAdoption.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Current adoption level">
        Adoption
      </SortableHeader>
    ),
    cell: ({ row }) => <RatingCell rating={row.original.currentAdoption} />,
    sortingFn: (rowA, rowB) => {
      const a = getLevelSortValue(rowA.original.currentAdoption.level)
      const b = getLevelSortValue(rowB.original.currentAdoption.level)
      return a - b
    },
  },
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
      return (
        <div
          className="text-[9px] text-red-700 dark:text-red-400 max-w-[100px] truncate"
          title={critiques.join('\n• ')}
        >
          {critiques.length > 0 && `• ${critiques[0]}`}
          {critiques.length > 1 && <span className="text-muted-foreground ml-1">(+{critiques.length - 1})</span>}
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
        return <span className="text-[9px] text-muted-foreground">—</span>
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
