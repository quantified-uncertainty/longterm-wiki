"use client"

// Accident Risks Comparison Table
import { useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  createAccidentRisksColumns,
  ACCIDENT_RISKS_COLUMNS,
  ACCIDENT_RISKS_PRESETS,
} from "../accident-risks-columns"
import { riskCategoryColors, getBadgeClass } from "../shared/table-view-styles"
import {
  accidentRisks,
  riskCategories,
} from "@data/tables/accident-risks"
import { TableViewPage } from "../shared/TableViewPage"

function LegendBadge({ level, category }: { level: string; category?: string }) {
  const displayLevel = level
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold",
        getBadgeClass(level, category)
      )}
    >
      {displayLevel}
    </span>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-6 mb-6 p-4 bg-muted/30 rounded-lg max-w-6xl">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Abstraction Level
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="THEORETICAL" category="abstraction" /> Foundational
          concepts
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MECHANISM" category="abstraction" /> How failures
          occur
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="BEHAVIOR" category="abstraction" /> Observable
          actions
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="OUTCOME" category="abstraction" /> Resulting
          scenarios
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Evidence</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="OBSERVED_CURRENT" category="evidence" /> In current
          systems
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="DEMONSTRATED_LAB" category="evidence" /> Lab
          experiments
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="THEORETICAL" category="evidence" /> First principles
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="SPECULATIVE" category="evidence" /> Hypothesized
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Timeline</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="CURRENT" category="timeline" /> Now
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="NEAR_TERM" category="timeline" /> 1-3 years
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MEDIUM_TERM" category="timeline" /> 3-10 years
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="LONG_TERM" category="timeline" /> 10+ years
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">Severity</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="EXISTENTIAL" category="severity" /> Extinction risk
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="CATASTROPHIC" category="severity" /> Civilizational
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="HIGH" category="severity" /> Significant harm
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MEDIUM" category="severity" /> Real harm
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="LOW" category="severity" /> Minor harm
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Detectability
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="EASY" category="detectability" /> Obvious
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="MODERATE" category="detectability" /> With effort
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="DIFFICULT" category="detectability" /> Sophisticated
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="VERY_DIFFICULT" category="detectability" /> May be
          impossible
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold text-foreground mb-1">
          Relationships
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="requires" category="relationship" /> Needs as
          precondition
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="enables" category="relationship" /> Can lead to
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="overlaps" category="relationship" /> Conceptual
          similarity
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <LegendBadge level="manifestation-of" category="relationship" />{" "}
          Behavioral expression
        </div>
      </div>
    </div>
  )
}

export default function AccidentRisksTableView() {
  const scrollToRisk = useCallback((riskId: string) => {
    const element = document.getElementById(`risk-${riskId}`)
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" })
      element.style.background = "#fef3c7"
      setTimeout(() => {
        element.style.background = ""
      }, 2000)
    }
  }, [])

  const createColumns = useCallback(
    () => createAccidentRisksColumns(scrollToRisk),
    [scrollToRisk]
  )

  return (
    <TableViewPage
      data={accidentRisks}
      createColumns={createColumns}
      columnConfig={ACCIDENT_RISKS_COLUMNS}
      columnPresets={ACCIDENT_RISKS_PRESETS}
      pinnedColumn="name"
      defaultSorting={[{ id: "category", desc: false }]}
      grouping={{
        groupByField: "category",
        groupOrder: [...riskCategories],
        groupLabels: Object.fromEntries(riskCategories.map((c) => [c, c])),
        headerStyle: "inline-color",
        groupDotColors: Object.fromEntries(
          riskCategories.map((c) => [c, riskCategoryColors[c] || "#6b7280"])
        ),
      }}
      description={
        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Comparative analysis of AI accident risks with explicit handling of
            overlaps and relationships. Many risks are closely related - scheming
            is the behavioral expression of deceptive alignment, which requires
            mesa-optimization as a precondition.
          </p>

          <div className="bg-red-100 dark:bg-red-950 border border-red-300 dark:border-red-800 rounded-lg p-3">
            <strong className="text-red-800 dark:text-red-200">
              Key insight:
            </strong>{" "}
            <span className="text-red-700 dark:text-red-300">
              Risks exist at different levels of abstraction.{" "}
              <em>Theoretical frameworks</em> (mesa-optimization, instrumental
              convergence) describe why problems occur. <em>Mechanisms</em>{" "}
              (deceptive alignment, goal misgeneralization) describe how failures
              happen. <em>Behaviors</em> (scheming, power-seeking) are what we
              observe. <em>Outcomes</em> (treacherous turn, sharp left turn) are
              the resulting scenarios.
            </span>
          </div>

          <div className="bg-blue-100 dark:bg-blue-950 border border-blue-300 dark:border-blue-800 rounded-lg p-3">
            <strong className="text-blue-800 dark:text-blue-200">
              Handling overlaps:
            </strong>{" "}
            <span className="text-blue-700 dark:text-blue-300">
              Each risk shows its <em>related risks</em> with relationship types:
              <strong> requires</strong> (needs the other as precondition),
              <strong> enables</strong> (can lead to),
              <strong> overlaps</strong> (conceptual similarity),
              <strong> manifestation-of</strong> (behavioral expression of),
              <strong> special-case-of</strong> (specific instance).
            </span>
          </div>
        </div>
      }
      legend={<Legend />}
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {accidentRisks.length} risks across {riskCategories.length} categories
        </div>
      }
    />
  )
}
