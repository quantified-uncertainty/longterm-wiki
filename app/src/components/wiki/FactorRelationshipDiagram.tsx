import React from "react";
import { getCategories, getOverviewEdges } from "@/data/master-graph-data";
import { cn } from "@lib/utils";

interface FactorRelationshipDiagramProps {
  nodeId: string;
  direction?: "incoming" | "outgoing";
  showSubItems?: boolean;
  className?: string;
  "client:load"?: boolean;
}

/**
 * Shows relationships for an ATM node — which categories feed into it
 * (incoming) or which it affects (outgoing).
 *
 * Renders as a simple list of related factors with relationship arrows,
 * using the overview-level category edges from the master graph.
 */
export function FactorRelationshipDiagram({
  nodeId,
  direction = "outgoing",
  showSubItems = false,
  className,
}: FactorRelationshipDiagramProps) {
  const categories = getCategories();
  const edges = getOverviewEdges();

  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const thisCategory = categoryMap.get(nodeId);

  if (!thisCategory) return null;

  // Find related categories based on direction
  const related = direction === "incoming"
    ? edges
        .filter((e) => e.target === nodeId)
        .map((e) => ({ edge: e, category: categoryMap.get(e.source) }))
        .filter((r) => r.category)
    : edges
        .filter((e) => e.source === nodeId)
        .map((e) => ({ edge: e, category: categoryMap.get(e.target) }))
        .filter((r) => r.category);

  if (related.length === 0) return null;

  const label = direction === "incoming" ? "Influenced by" : "Influences";

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {label}
      </h3>
      <div className="space-y-2">
        {related.map((r, i) => {
          const cat = r.category!;
          const strength = r.edge.data?.strength || "medium";
          const effect = r.edge.data?.effect || "increases";

          const strengthDot = strength === "strong"
            ? "bg-red-500"
            : strength === "medium"
            ? "bg-yellow-500"
            : "bg-slate-400";

          const effectArrow = effect === "increases" ? "+" : effect === "decreases" ? "−" : "±";

          return (
            <div key={i} className="flex items-start gap-2">
              <span className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", strengthDot)} />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  <span className="text-muted-foreground mr-1">{effectArrow}</span>
                  {cat.label}
                </div>
                {cat.description && (
                  <p className="text-xs text-muted-foreground line-clamp-1">{cat.description}</p>
                )}
                {showSubItems && cat.subItems && cat.subItems.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {cat.subItems.map((sub) => (
                      <span key={sub.id} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
                        {sub.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> strong
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" /> medium
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" /> weak
        </span>
      </div>
    </div>
  );
}
