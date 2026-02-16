import React from "react";
import { cn } from "@lib/utils";
import { domainBadge, stanceBadge, feasibilityDot } from "./badge-styles";

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
}

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
