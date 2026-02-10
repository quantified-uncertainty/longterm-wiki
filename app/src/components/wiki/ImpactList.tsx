import React from "react";
import { getCategories, getOverviewEdges } from "@/data/master-graph-data";
import { cn } from "@lib/utils";

interface ImpactListProps {
  nodeId: string;
  direction?: "from" | "to";
  compact?: boolean;
  className?: string;
  "client:load"?: boolean;
}

/**
 * Shows what scenarios/outcomes are connected to a given ATM node.
 *
 * - direction="to": what this node contributes to (outgoing impacts)
 * - direction="from": what contributes to this node (incoming impacts)
 */
export function ImpactList({
  nodeId,
  direction = "to",
  compact = false,
  className,
}: ImpactListProps) {
  const categories = getCategories();
  const edges = getOverviewEdges();

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // Find connected nodes
  const connections = direction === "from"
    ? edges
        .filter((e) => e.target === nodeId)
        .map((e) => ({ edge: e, category: categoryMap.get(e.source) }))
        .filter((c) => c.category)
    : edges
        .filter((e) => e.source === nodeId)
        .map((e) => ({ edge: e, category: categoryMap.get(e.target) }))
        .filter((c) => c.category);

  if (connections.length === 0) return null;

  const label = direction === "from" ? "Contributing Factors" : "Impacts";

  if (compact) {
    return (
      <div className={cn("my-3", className)}>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}:{" "}
        </span>
        <span className="text-sm">
          {connections.map((c, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {c.category!.label}
            </span>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {label}
      </h3>
      <ul className="space-y-1.5">
        {connections.map((c, i) => {
          const cat = c.category!;
          const effect = c.edge.data?.effect || "increases";
          const effectIcon = effect === "increases" ? "↑" : effect === "decreases" ? "↓" : "↕";
          const typeLabel = cat.type === "intermediate"
            ? "Scenario"
            : cat.type === "effect"
            ? "Outcome"
            : "Factor";

          return (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{effectIcon}</span>
              <span className="font-medium">{cat.label}</span>
              <span className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                {typeLabel}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
