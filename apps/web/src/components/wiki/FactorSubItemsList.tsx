import * as React from "react"
import {
  getRootFactors,
  getNodeById,
  type RootFactor,
  type SubItem,
} from "@/data/parameter-graph-data"

interface FactorSubItemsListProps {
  factorId: string
  showDescription?: boolean
  showRatings?: boolean
  variant?: "list" | "cards" | "compact"
}

export function FactorSubItemsList({
  factorId,
  showDescription = false,
  showRatings = false,
  variant = "list",
}: FactorSubItemsListProps) {
  const node = getNodeById(factorId)

  if (!node || !node.subItems || node.subItems.length === 0) {
    return <span className="text-muted-foreground">No sub-items defined</span>
  }

  if (variant === "compact") {
    return (
      <span className="text-muted-foreground">
        {node.subItems.map((item, i) => (
          <React.Fragment key={item.label}>
            {item.href ? (
              <a href={item.href} className="text-primary hover:underline">
                {item.label}
              </a>
            ) : (
              item.label
            )}
            {i < node.subItems!.length - 1 && ", "}
          </React.Fragment>
        ))}
      </span>
    )
  }

  if (variant === "cards") {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {node.subItems.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-border p-4"
          >
            <h4 className="font-semibold mb-2">
              {item.href ? (
                <a href={item.href} className="text-primary hover:underline">
                  {item.label}
                </a>
              ) : (
                item.label
              )}
            </h4>
            {showDescription && item.description && (
              <p className="text-sm text-muted-foreground line-clamp-3">
                {item.description.split("\n")[0]}
              </p>
            )}
            {showRatings && item.ratings && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {item.ratings.xriskImpact !== undefined && (
                  <span className="px-2 py-1 bg-red-100 dark:bg-red-900/30 rounded">
                    X-risk: {item.ratings.xriskImpact}
                  </span>
                )}
                {item.ratings.changeability !== undefined && (
                  <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded">
                    Change: {item.ratings.changeability}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  // Default: list variant
  return (
    <ul className="list-disc list-inside space-y-1">
      {node.subItems.map((item) => (
        <li key={item.label} className="text-muted-foreground">
          {item.href ? (
            <a href={item.href} className="text-primary hover:underline">
              {item.label}
            </a>
          ) : (
            <span>{item.label}</span>
          )}
          {showDescription && item.description && (
            <span className="text-sm ml-2">
              — {item.description.split("\n")[0].slice(0, 150)}
              {item.description.length > 150 ? "..." : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

interface AllFactorsSubItemsProps {
  showDescription?: boolean
  variant?: "grouped" | "flat"
}

export function AllFactorsSubItems({
  showDescription = false,
  variant = "grouped",
}: AllFactorsSubItemsProps) {
  const factors = getRootFactors()

  if (variant === "flat") {
    const allSubItems = factors.flatMap((f) =>
      (f.subItems || []).map((item) => ({
        ...item,
        factorLabel: f.label,
        factorId: f.id,
      }))
    )

    return (
      <ul className="list-disc list-inside space-y-1">
        {allSubItems.map((item) => (
          <li
            key={`${item.factorId}-${item.label}`}
            className="text-muted-foreground"
          >
            {item.href ? (
              <a href={item.href} className="text-primary hover:underline">
                {item.label}
              </a>
            ) : (
              <span>{item.label}</span>
            )}
            <span className="text-xs text-muted-foreground ml-2">
              ({item.factorLabel})
            </span>
          </li>
        ))}
      </ul>
    )
  }

  // Grouped by factor
  return (
    <div className="space-y-6">
      {factors.map((factor) => (
        <div key={factor.id}>
          <h3 className="font-semibold mb-2">
            {factor.href ? (
              <a href={factor.href} className="text-primary hover:underline">
                {factor.label}
              </a>
            ) : (
              factor.label
            )}
          </h3>
          <FactorSubItemsList
            factorId={factor.id}
            showDescription={showDescription}
            variant="list"
          />
        </div>
      ))}
    </div>
  )
}

export default FactorSubItemsList
