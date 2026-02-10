"use client"

// Table view for Deployment / Safety Architectures
import { useCallback } from "react"
import {
  createDeploymentArchitecturesColumns,
  DEPLOYMENT_COLUMNS,
  DEPLOYMENT_PRESETS,
  CATEGORIES,
} from "../deployment-architectures-columns"
import { architectures, CATEGORY_ORDER } from "@data/tables/ai-architectures"
import { TableViewPage } from "../shared/TableViewPage"

export default function DeploymentArchitecturesTableView() {
  const createColumns = useCallback(() => createDeploymentArchitecturesColumns(), [])

  return (
    <TableViewPage
      title="Deployment / Safety Architectures"
      breadcrumbs={[
        { label: "Knowledge Base", href: "/wiki/knowledge-base/" },
        { label: "All Tables", href: "/wiki/interactive-views/" },
      ]}
      navLinks={[
        {
          label: "Model Architectures",
          href: "/wiki/architecture-scenarios-table/",
        },
        {
          label: "Deployment Architectures",
          href: "/wiki/deployment-architectures-table/",
          active: true,
        },
        {
          label: "Safety Approaches",
          href: "/wiki/safety-approaches-table/",
        },
      ]}
      data={architectures}
      createColumns={createColumns}
      columnConfig={DEPLOYMENT_COLUMNS}
      columnPresets={DEPLOYMENT_PRESETS}
      pinnedColumn="name"
      defaultViewMode="grouped"
      grouping={{
        groupByField: "category",
        groupOrder: [...CATEGORY_ORDER],
        groupLabels: Object.fromEntries(
          CATEGORY_ORDER.map((c) => [c, CATEGORIES[c].label])
        ),
        groupDescriptions: Object.fromEntries(
          CATEGORY_ORDER.map((c) => [c, CATEGORIES[c].description])
        ),
        headerStyle: "dark-slate",
      }}
      description={
        <div className="max-w-4xl space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">
              How AI systems are organized for safety.
            </strong>{" "}
            These architectures are largely model-agnostic - they can be applied
            to transformers, SSMs, or future architectures. The key question:
            how do we structure AI systems to maintain oversight and safety?
          </p>
          <p className="text-xs">
            <strong>Key insight:</strong> Lower agency + more decomposition +
            better oversight = generally safer. But there are tradeoffs with
            capability and practicality. See also:{" "}
            <a
              href="/wiki/architecture-scenarios-table/"
              className="text-primary hover:underline"
            >
              Model Architectures
            </a>{" "}
            for what the AI is made of.
          </p>
        </div>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {architectures.length} architectures across {CATEGORY_ORDER.length}{" "}
          categories
        </div>
      }
    />
  )
}
