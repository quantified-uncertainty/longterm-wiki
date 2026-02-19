"use client"

// Table view for Safety Research Generalizability Model (client component)
import { useCallback } from "react"
import {
  createSafetyGeneralizabilityColumns,
  SAFETY_GENERALIZABILITY_COLUMNS,
  SAFETY_GENERALIZABILITY_PRESETS,
  type SafetyApproach,
} from "../safety-generalizability-columns"
import { TableViewPage } from "../shared/TableViewPage"

interface SafetyGeneralizabilityTableViewClientProps {
  approaches: SafetyApproach[]
}

export default function SafetyGeneralizabilityTableViewClient({
  approaches,
}: SafetyGeneralizabilityTableViewClientProps) {
  const createColumns = useCallback(() => createSafetyGeneralizabilityColumns(), [])

  return (
    <TableViewPage
      navLinks={[
        {
          label: "Table",
          href: "/wiki/safety-generalizability-table/",
          active: true,
        },
        {
          label: "Safety Approaches",
          href: "/wiki/safety-approaches-table/",
        },
      ]}
      data={approaches}
      createColumns={createColumns}
      columnConfig={SAFETY_GENERALIZABILITY_COLUMNS}
      columnPresets={SAFETY_GENERALIZABILITY_PRESETS}
      pinnedColumn="label"
      defaultSorting={[{ id: "generalizationLevel", desc: false }]}
      className="min-h-screen flex flex-col bg-background"
      description={
        <p className="text-sm text-muted-foreground max-w-6xl">
          This table summarizes which AI safety research approaches are likely to
          generalize to future AI architectures, and what conditions they depend
          on. Approaches are ordered from lowest to highest expected
          generalization.
        </p>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {approaches.length} safety approaches
        </div>
      }
    />
  )
}
