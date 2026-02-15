import React from "react";
import { cn } from "@lib/utils";

interface ProposalSummary {
  id: string;
  name: string;
  domain?: string;
  stance?: string;
  costEstimate?: string;
  evEstimate?: string;
  feasibility?: string;
  description?: string;
}

interface ProposalListProps {
  title?: string;
  proposals: ProposalSummary[];
  className?: string;
  "client:load"?: boolean;
}

const domainBadge: Record<string, string> = {
  philanthropic: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  biosecurity: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  governance: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  technical: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "field-building": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  financial: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

const stanceBadge: Record<string, string> = {
  collaborative: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  adversarial: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const feasibilityDot: Record<string, string> = {
  high: "bg-green-500",
  medium: "bg-yellow-500",
  low: "bg-red-500",
};

export function ProposalList({ title, proposals, className }: ProposalListProps) {
  if (!proposals || proposals.length === 0) return null;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title || "Proposals"}
        <span className="font-normal ml-1">({proposals.length})</span>
      </h3>
      <div className="space-y-3">
        {proposals.map((item) => (
          <div key={item.id} className="border-l-2 border-muted pl-3 py-1">
            <div className="flex items-start gap-2">
              {item.feasibility && (
                <span
                  className={cn(
                    "w-2 h-2 rounded-full mt-1 shrink-0",
                    feasibilityDot[item.feasibility] || feasibilityDot.medium
                  )}
                  title={`Feasibility: ${item.feasibility}`}
                />
              )}
              <span className="text-xs font-medium flex-1">{item.name}</span>
              <div className="flex gap-1 shrink-0">
                {item.domain && (
                  <span
                    className={cn(
                      "text-[10px] rounded px-1.5 py-0.5 font-medium",
                      domainBadge[item.domain] || domainBadge.governance
                    )}
                  >
                    {item.domain}
                  </span>
                )}
                {item.stance && (
                  <span
                    className={cn(
                      "text-[10px] rounded px-1.5 py-0.5 font-medium",
                      stanceBadge[item.stance] || stanceBadge.neutral
                    )}
                  >
                    {item.stance}
                  </span>
                )}
              </div>
            </div>
            {(item.costEstimate || item.evEstimate) && (
              <div className="text-[10px] text-muted-foreground mt-0.5 flex gap-3">
                {item.costEstimate && <span>Cost: {item.costEstimate}</span>}
                {item.evEstimate && <span>EV: {item.evEstimate}</span>}
              </div>
            )}
            {item.description && (
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
