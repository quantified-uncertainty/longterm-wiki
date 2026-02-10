import React from "react";
import { cn } from "@lib/utils";

interface CruxSummary {
  id: string;
  question: string;
  importance?: string;
  timeframe?: string;
  summary?: string;
}

interface CruxListProps {
  domain?: string;
  cruxes: CruxSummary[];
  className?: string;
  "client:load"?: boolean;
}

const importanceBadge: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function CruxList({ domain, cruxes, className }: CruxListProps) {
  if (!cruxes || cruxes.length === 0) return null;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {domain ? `${domain} Cruxes` : "Key Cruxes"}
        <span className="font-normal ml-1">({cruxes.length})</span>
      </h3>
      <div className="space-y-3">
        {cruxes.map((crux) => (
          <div key={crux.id} className="border-l-2 border-muted pl-3 py-1">
            <div className="flex items-start gap-2">
              <span className="text-xs font-medium flex-1">{crux.question}</span>
              <div className="flex gap-1 shrink-0">
                {crux.importance && (
                  <span
                    className={cn(
                      "text-[10px] rounded px-1.5 py-0.5 font-medium",
                      importanceBadge[crux.importance] || importanceBadge.medium
                    )}
                  >
                    {crux.importance}
                  </span>
                )}
                {crux.timeframe && (
                  <span className="text-[10px] bg-muted rounded px-1.5 py-0.5">
                    {crux.timeframe}
                  </span>
                )}
              </div>
            </div>
            {crux.summary && (
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                {crux.summary}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
