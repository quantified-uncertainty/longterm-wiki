"use client"

// Architecture Scenarios Table View
import { useCallback } from "react"
import {
  createArchitectureScenariosColumns,
  ARCHITECTURE_COLUMNS,
  ARCHITECTURE_PRESETS,
} from "../architecture-scenarios-columns"
import {
  scenarios,
  CATEGORIES,
  CATEGORY_ORDER,
} from "@data/tables/architecture-scenarios"
import { categoryColors } from "../shared/table-view-styles"
import { TableViewPage } from "../shared/TableViewPage"

export default function ArchitectureScenariosTableView() {
  const createColumns = useCallback(() => createArchitectureScenariosColumns(), [])

  return (
    <TableViewPage
      title="Scalable Intelligence Paradigms"
      breadcrumbs={[
        { label: "Knowledge Base", href: "/wiki/knowledge-base/" },
        { label: "All Tables", href: "/wiki/interactive-views/" },
      ]}
      navLinks={[
        {
          label: "Model Architectures",
          href: "/wiki/architecture-scenarios-table/",
          active: true,
        },
        {
          label: "Deployment Architectures",
          href: "/wiki/deployment-architectures-table/",
        },
        {
          label: "Safety Approaches",
          href: "/wiki/safety-approaches-table/",
        },
      ]}
      data={scenarios}
      createColumns={createColumns}
      columnConfig={ARCHITECTURE_COLUMNS}
      columnPresets={ARCHITECTURE_PRESETS}
      pinnedColumn="name"
      defaultSorting={[{ id: "category", desc: false }]}
      grouping={{
        groupByField: "category",
        groupOrder: [...CATEGORY_ORDER],
        groupLabels: Object.fromEntries(
          CATEGORY_ORDER.map((c) => [c, CATEGORIES[c].label])
        ),
        groupDescriptions: Object.fromEntries(
          CATEGORY_ORDER.map((c) => [c, CATEGORIES[c].description])
        ),
        headerStyle: "colored-dot",
        groupDotClasses: Object.fromEntries(
          CATEGORY_ORDER.map((c) => [c, categoryColors[c]?.dot || "bg-slate-500"])
        ),
      }}
      description={
        <div className="max-w-4xl space-y-4">
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground select-none">
              Similar tables elsewhere
            </summary>
            <div className="mt-2 pl-4 border-l-2 border-muted space-y-1">
              <div>
                <a
                  href="https://artificialanalysis.ai/leaderboards/models"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Artificial Analysis
                </a>{" "}
                – Model capabilities (100+ models)
              </div>
              <div>
                <a
                  href="https://epoch.ai/benchmarks"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Epoch AI Benchmarks
                </a>{" "}
                – Historical benchmark trends
              </div>
              <div>
                <a
                  href="https://www.vellum.ai/llm-leaderboard"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener"
                >
                  Vellum LLM Leaderboard
                </a>{" "}
                – Price &amp; context comparison
              </div>
            </div>
          </details>

          <p className="text-sm text-muted-foreground">
            Paradigms for transformative intelligence.{" "}
            <strong>Structure:</strong> We separate <em>deployment patterns</em>{" "}
            (minimal → heavy scaffolding) from <em>base architectures</em>{" "}
            (transformers, SSMs, etc.). These are orthogonal - real systems
            combine both. E.g., &quot;Heavy scaffolding + MoE transformer&quot; is one
            concrete system.
          </p>

          <p className="text-xs text-muted-foreground">
            <strong>Key insight:</strong> Scaffold code is actually{" "}
            <em>more</em> interpretable than model internals. We can read and
            verify orchestration logic; we can&apos;t read transformer weights.
          </p>
        </div>
      }
      footer={
        <div className="text-xs text-muted-foreground mt-4">
          {scenarios.length} scenarios across {CATEGORY_ORDER.length} categories
        </div>
      }
    />
  )
}
