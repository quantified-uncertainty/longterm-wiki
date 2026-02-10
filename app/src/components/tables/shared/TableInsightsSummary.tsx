"use client"

/**
 * TableInsightsSummary - Shows related insights on table pages
 *
 * Displays a collapsible section showing insights that:
 * 1. Reference this table via tableRef
 * 2. Share relevant tags with the table
 *
 * Used on table pages to show derived insights and analysis.
 */

import * as React from "react"
import { ChevronDown, ChevronUp, Lightbulb, ExternalLink } from "lucide-react"
import { insights, getInsightsByTable, getInsightsByTag, type Insight, type InsightType } from "@/data/insights-data"

interface TableInsightsSummaryProps {
  tableId: string
  tags?: string[]
  maxItems?: number
  defaultExpanded?: boolean
  /** If true, only show when dev mode is active (toggle in header) */
  devOnly?: boolean
}

const typeColors: Record<InsightType, string> = {
  'claim': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'research-gap': 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  'counterintuitive': 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  'quantitative': 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
  'disagreement': 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300',
  'neglected': 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
}

function RatingDot({ value }: { value: number }) {
  const colorClass = value >= 4.0
    ? "bg-emerald-500"
    : value >= 3.5
    ? "bg-emerald-400"
    : value >= 3.0
    ? "bg-amber-400"
    : "bg-slate-300"

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorClass}`}
      title={value.toFixed(1)}
    />
  )
}

function InsightCard({ insight }: { insight: Insight }) {
  return (
    <div className="p-3 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors">
      <div className="flex items-start gap-2">
        <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${typeColors[insight.type]}`}>
          {insight.type}
        </span>
        <p className="text-sm leading-relaxed flex-1">{insight.insight}</p>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1" title="Surprising">
          <RatingDot value={insight.surprising} /> S:{insight.surprising.toFixed(1)}
        </span>
        <span className="flex items-center gap-1" title="Important">
          <RatingDot value={insight.important} /> I:{insight.important.toFixed(1)}
        </span>
        <span className="flex items-center gap-1" title="Actionable">
          <RatingDot value={insight.actionable} /> A:{insight.actionable.toFixed(1)}
        </span>
        {insight.source && (
          <a
            href={insight.source}
            className="ml-auto flex items-center gap-1 text-primary hover:underline"
          >
            Source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}

export function TableInsightsSummary({
  tableId,
  tags = [],
  maxItems = 5,
  defaultExpanded = false,
  devOnly = true  // Default to dev-only mode
}: TableInsightsSummaryProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded)

  // Get insights that reference this table or share tags
  const relatedInsights = React.useMemo(() => {
    const byTable = getInsightsByTable(tableId)

    // Also get insights by shared tags
    const byTags = new Set<Insight>()
    for (const tag of tags) {
      for (const insight of getInsightsByTag(tag)) {
        // Avoid duplicates
        if (!byTable.find(i => i.id === insight.id)) {
          byTags.add(insight)
        }
      }
    }

    // Combine and sort by composite score
    const all = [...byTable, ...byTags]
    all.sort((a, b) => (b.composite || 0) - (a.composite || 0))

    return all
  }, [tableId, tags])

  if (relatedInsights.length === 0) {
    return null
  }

  const displayedInsights = expanded
    ? relatedInsights
    : relatedInsights.slice(0, maxItems)
  const hasMore = relatedInsights.length > maxItems

  // Dev-only class follows the same pattern as PageStatus
  const wrapperClass = devOnly ? 'dev-mode-only' : ''

  return (
    <div className={`rounded-lg border border-border bg-muted/20 ${wrapperClass}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <Lightbulb className="h-4 w-4 text-amber-500" />
        <span className="font-medium text-sm">
          Related Insights ({relatedInsights.length})
        </span>
        <span className="ml-auto text-muted-foreground">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Key insights derived from this table's data and analysis:
          </p>

          {displayedInsights.map(insight => (
            <InsightCard key={insight.id} insight={insight} />
          ))}

          {!expanded && hasMore && (
            <button
              onClick={() => setExpanded(true)}
              className="text-xs text-primary hover:underline"
            >
              Show {relatedInsights.length - maxItems} more insights...
            </button>
          )}

          <div className="pt-2 border-t border-border">
            <a
              href="/project/insights/"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              View all insights <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

export default TableInsightsSummary
