"use client"

// Safety Approaches Comparison Table
// Evaluates safety techniques on whether they actually make the world safer
// vs. primarily enabling more capable (potentially dangerous) systems

import { useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { SAFETY_APPROACHES, CATEGORIES } from "@data/tables/safety-approaches"
import {
  createSafetyApproachesColumns,
  SAFETY_APPROACHES_COLUMNS,
  SAFETY_APPROACHES_PRESETS,
} from "../safety-approaches-columns"
import {
  getBadgeColorClass,
  safetyCategoryColors,
} from "../shared/table-view-styles"
import { TableViewPage } from "../shared/TableViewPage"

function LegendBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold",
        getBadgeColorClass(level)
      )}
    >
      {level}
    </span>
  )
}

export default function SafetyApproachesTableView() {
  const createColumns = useCallback(() => createSafetyApproachesColumns(), [])

  return (
    <TableViewPage
      data={SAFETY_APPROACHES}
      createColumns={createColumns}
      columnConfig={SAFETY_APPROACHES_COLUMNS}
      columnPresets={SAFETY_APPROACHES_PRESETS}
      pinnedColumn="name"
      defaultSorting={[{ id: "category", desc: false }]}
      stickyFirstColumn
      grouping={{
        groupByField: "category",
        groupOrder: CATEGORIES.map((c) => c.id),
        groupLabels: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])),
        headerStyle: "colored-dot",
        groupDotClasses: Object.fromEntries(
          CATEGORIES.map((c) => [c.id, safetyCategoryColors[c.id]?.dot || "bg-slate-500"])
        ),
        hideCategoryColumnInGroupedMode: true,
        categoryColumnId: "category",
      }}
      description={
        <div className="max-w-4xl space-y-4">
          <details>
            <summary className="text-sm text-muted-foreground cursor-pointer hover:text-foreground select-none">
              Similar tables elsewhere ↗
            </summary>
            <div className="mt-2 pl-4 border-l-2 border-border text-sm space-y-1">
              <div>
                <a
                  href="https://futureoflife.org/ai-safety-index-winter-2025/"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  FLI AI Safety Index
                </a>{" "}
                – Lab safety scorecards
              </div>
              <div>
                <a
                  href="https://metr.org/common-elements"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  METR: Common Elements
                </a>{" "}
                – Policy comparison (12 companies)
              </div>
              <div>
                <a
                  href="https://arxiv.org/abs/2310.19852"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  AI Alignment Survey
                </a>{" "}
                – Academic taxonomy
              </div>
            </div>
          </details>

          <p className="text-muted-foreground leading-relaxed">
            Comparative analysis of AI safety approaches, with particular attention to the question:{" "}
            <strong className="text-foreground">
              Does this technique actually make the world safer, or does it primarily enable more
              capable systems?
            </strong>
          </p>

          <Card className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
            <CardContent className="py-3">
              <p className="text-sm">
                <strong className="text-amber-700 dark:text-amber-400">Key insight:</strong> Many
                &quot;safety&quot; techniques have <em>capability uplift</em> as their primary effect. RLHF, for
                example, is what makes ChatGPT useful - its safety benefit is secondary to its
                capability benefit. A technique that provides DOMINANT capability uplift with only LOW
                safety uplift may be net negative for world safety, even if it reduces obvious harms.
              </p>
            </CardContent>
          </Card>
        </div>
      }
      legend={
        <Card className="max-w-fit">
          <CardContent className="py-4">
            <div className="flex flex-wrap gap-6">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Safety Uplift</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="CRITICAL" /> Transformative if works</span>
                  <span><LegendBadge level="HIGH" /> Significant risk reduction</span>
                  <span><LegendBadge level="MEDIUM" /> Meaningful but limited</span>
                  <span><LegendBadge level="LOW" /> Marginal benefit</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Capability Uplift</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="DOMINANT" /> Primary capability driver</span>
                  <span><LegendBadge level="SIGNIFICANT" /> Major capability boost</span>
                  <span><LegendBadge level="SOME" /> Some capability benefit</span>
                  <span><LegendBadge level="NEUTRAL" /> No capability effect</span>
                  <span><LegendBadge level="TAX" /> Reduces capabilities</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Net World Safety</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="HELPFUL" /> Probably net positive</span>
                  <span><LegendBadge level="UNCLEAR" /> Could go either way</span>
                  <span><LegendBadge level="HARMFUL" /> Likely net negative</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Scales to SI?</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="YES" /> Works at superintelligence</span>
                  <span><LegendBadge level="MAYBE" /> Might work</span>
                  <span><LegendBadge level="UNLIKELY" /> Probably breaks</span>
                  <span><LegendBadge level="NO" /> Fundamentally limited</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Differential Progress</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="SAFETY-DOMINANT" /> Safety &gt;&gt; capability</span>
                  <span><LegendBadge level="SAFETY-LEANING" /> Safety &gt; capability</span>
                  <span><LegendBadge level="BALANCED" /> Roughly equal</span>
                  <span><LegendBadge level="CAPABILITY-LEANING" /> Capability &gt; safety</span>
                  <span><LegendBadge level="CAPABILITY-DOMINANT" /> Capability &gt;&gt; safety</span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Recommendation</p>
                <div className="flex flex-col gap-1 text-[10px]">
                  <span><LegendBadge level="PRIORITIZE" /> Needs much more funding</span>
                  <span><LegendBadge level="INCREASE" /> Should grow</span>
                  <span><LegendBadge level="MAINTAIN" /> About right</span>
                  <span><LegendBadge level="REDUCE" /> Overfunded for safety</span>
                  <span><LegendBadge level="DEFUND" /> Counterproductive</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      }
    />
  )
}
