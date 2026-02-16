import React from "react";
import { cn } from "@lib/utils";
import { domainBadge, stanceBadge, feasibilityColor, statusLabel } from "./badge-styles";

interface ProposalCardProps {
  id?: string;
  name: string;
  description?: string;
  sourcePageId?: string;
  domain?: string;
  stance?: string;
  costEstimate?: string;
  evEstimate?: string;
  feasibility?: string;
  honestConcerns?: string;
  status?: string;
  leadOrganizations?: string[];
  relatedProposals?: string[];
  className?: string;
}

export function ProposalCard({
  name,
  description,
  domain,
  stance,
  costEstimate,
  evEstimate,
  feasibility,
  honestConcerns,
  status,
  leadOrganizations,
  relatedProposals,
  className,
}: ProposalCardProps) {
  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h4 className="text-sm font-semibold leading-snug flex-1">{name}</h4>
        <div className="flex gap-1.5 shrink-0">
          {domain && (
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 font-medium",
                domainBadge[domain] || domainBadge.governance
              )}
            >
              {domain}
            </span>
          )}
          {stance && (
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 font-medium",
                stanceBadge[stance] || stanceBadge.neutral
              )}
            >
              {stance}
            </span>
          )}
        </div>
      </div>

      {/* Description */}
      {description && (
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
      )}

      {/* Cost / EV / Feasibility row */}
      {(costEstimate || evEstimate || feasibility || status) && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mb-3">
          {costEstimate && (
            <div>
              <span className="text-muted-foreground">Est. cost: </span>
              <strong>{costEstimate}</strong>
            </div>
          )}
          {evEstimate && (
            <div>
              <span className="text-muted-foreground">Est. EV: </span>
              <strong>{evEstimate}</strong>
            </div>
          )}
          {feasibility && (
            <div>
              <span className="text-muted-foreground">Feasibility: </span>
              <strong className={feasibilityColor[feasibility] || ""}>{feasibility}</strong>
            </div>
          )}
          {status && (
            <div>
              <span className="text-muted-foreground">Status: </span>
              <strong>{statusLabel[status] || status}</strong>
            </div>
          )}
        </div>
      )}

      {/* Honest concerns */}
      {honestConcerns && (
        <div className="mb-3 border-l-2 border-orange-300 dark:border-orange-700 pl-3 py-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-400 mb-0.5">
            Honest Concerns
          </div>
          <div className="text-xs text-muted-foreground">{honestConcerns}</div>
        </div>
      )}

      {/* Lead organizations */}
      {leadOrganizations && leadOrganizations.length > 0 && (
        <div className="flex flex-wrap gap-x-4 text-[11px] text-muted-foreground mb-2">
          <span>Could lead: <strong>{leadOrganizations.join(", ")}</strong></span>
        </div>
      )}

      {/* Related proposals */}
      {relatedProposals && relatedProposals.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-[10px] text-muted-foreground mr-1">Related:</span>
          {relatedProposals.map((p) => (
            <span key={p} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
