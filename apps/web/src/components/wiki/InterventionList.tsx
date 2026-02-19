import React from "react";
import { cn } from "@lib/utils";
import { priorityBadge, categoryBadge } from "./badge-styles";

interface InterventionSummary {
  id: string;
  name: string;
  category?: string;
  overallPriority?: string;
  timelineFit?: string;
  description?: string;
}

interface InterventionListProps {
  title?: string;
  interventions: InterventionSummary[];
  className?: string;
}

export function InterventionList({ title, interventions, className }: InterventionListProps) {
  if (!interventions || interventions.length === 0) return null;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title || "Interventions"}
        <span className="font-normal ml-1">({interventions.length})</span>
      </h3>
      <div className="space-y-3">
        {interventions.map((item) => (
          <div key={item.id} className="border-l-2 border-muted pl-3 py-1">
            <div className="flex items-start gap-2">
              <span className="text-xs font-medium flex-1">{item.name}</span>
              <div className="flex gap-1 shrink-0">
                {item.category && (
                  <span
                    className={cn(
                      "text-[10px] rounded px-1.5 py-0.5 font-medium",
                      categoryBadge[item.category] || categoryBadge.technical
                    )}
                  >
                    {item.category}
                  </span>
                )}
                {item.overallPriority && (
                  <span
                    className={cn(
                      "text-[10px] rounded px-1.5 py-0.5 font-medium",
                      priorityBadge[item.overallPriority] || priorityBadge.Medium
                    )}
                  >
                    {item.overallPriority}
                  </span>
                )}
                {item.timelineFit && (
                  <span className="text-[10px] bg-muted rounded px-1.5 py-0.5">
                    {item.timelineFit}
                  </span>
                )}
              </div>
            </div>
            {item.description && (
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                {item.description}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
