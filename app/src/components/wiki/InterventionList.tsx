import React from "react";
import { cn } from "@lib/utils";

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
  "client:load"?: boolean;
}

const priorityBadge: Record<string, string> = {
  "Very High": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "High": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "Medium-High": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "Medium": "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const categoryBadge: Record<string, string> = {
  technical: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  governance: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  institutional: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "field-building": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  resilience: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

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
