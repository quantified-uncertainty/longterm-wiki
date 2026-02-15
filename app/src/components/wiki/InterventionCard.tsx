import React from "react";
import { cn } from "@lib/utils";
import { priorityBadge, categoryBadge, coverageColor, itnLabel } from "./badge-styles";

interface RiskCoverage {
  accident?: string;
  misuse?: string;
  structural?: string;
  epistemic?: string;
}

interface ResearchRef {
  title: string;
  url?: string;
}

interface InterventionCardProps {
  id?: string;
  name: string;
  category?: string;
  description?: string;
  riskCoverage?: RiskCoverage;
  primaryMechanism?: string;
  tractability?: string;
  neglectedness?: string;
  importance?: string;
  overallPriority?: string;
  timelineFit?: string;
  currentState?: string;
  fundingLevel?: string;
  recommendedShift?: string;
  relatedInterventions?: string[];
  relevantResearch?: ResearchRef[];
  className?: string;
}

export function InterventionCard({
  name,
  category,
  description,
  riskCoverage,
  primaryMechanism,
  tractability,
  neglectedness,
  importance,
  overallPriority,
  timelineFit,
  currentState,
  fundingLevel,
  recommendedShift,
  relatedInterventions,
  relevantResearch,
  className,
}: InterventionCardProps) {
  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h4 className="text-sm font-semibold leading-snug flex-1">{name}</h4>
        <div className="flex gap-1.5 shrink-0">
          {category && (
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 font-medium",
                categoryBadge[category] || categoryBadge.technical
              )}
            >
              {category}
            </span>
          )}
          {overallPriority && (
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 font-medium",
                priorityBadge[overallPriority] || priorityBadge.Medium
              )}
            >
              {overallPriority}
            </span>
          )}
        </div>
      </div>

      {/* Description */}
      {description && (
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
      )}

      {/* Primary mechanism */}
      {primaryMechanism && (
        <div className="text-[11px] text-muted-foreground mb-3 italic">
          Mechanism: {primaryMechanism}
        </div>
      )}

      {/* ITN + Timeline row */}
      {(tractability || neglectedness || importance || timelineFit) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-3">
          {tractability && (
            <span>Tractability: <strong>{itnLabel[tractability] || tractability}</strong></span>
          )}
          {importance && (
            <span>Impact: <strong>{itnLabel[importance] || importance}</strong></span>
          )}
          {neglectedness && (
            <span>Neglectedness: <strong>{itnLabel[neglectedness] || neglectedness}</strong></span>
          )}
          {timelineFit && (
            <span>Timeline: <strong>{timelineFit}</strong></span>
          )}
        </div>
      )}

      {/* Risk coverage matrix */}
      {riskCoverage && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Risk Coverage
          </div>
          <div className="grid grid-cols-4 gap-2 text-[11px]">
            {(["accident", "misuse", "structural", "epistemic"] as const).map((risk) => {
              const level = riskCoverage[risk] || "none";
              return (
                <div key={risk} className="text-center">
                  <div className="text-[10px] text-muted-foreground capitalize">{risk}</div>
                  <div className={coverageColor[level] || coverageColor.none}>
                    {level === "none" ? "—" : level}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Current state */}
      {currentState && (
        <div className="mb-3 border-l-2 border-muted pl-3 py-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
            Current State
          </div>
          <div className="text-xs text-muted-foreground">{currentState}</div>
        </div>
      )}

      {/* Funding */}
      {(fundingLevel || recommendedShift) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-3">
          {fundingLevel && (
            <span>Funding: <strong>{fundingLevel}</strong></span>
          )}
          {recommendedShift && (
            <span>Recommended: <strong>{recommendedShift}</strong></span>
          )}
        </div>
      )}

      {/* Related interventions */}
      {relatedInterventions && relatedInterventions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          <span className="text-[10px] text-muted-foreground mr-1">Related:</span>
          {relatedInterventions.map((intervention) => (
            <span key={intervention} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
              {intervention}
            </span>
          ))}
        </div>
      )}

      {/* Relevant research */}
      {relevantResearch && relevantResearch.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {relevantResearch.map((research, i) =>
            research.url ? (
              <a
                key={i}
                href={research.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary hover:underline"
              >
                {research.title} ↗
              </a>
            ) : (
              <span key={i} className="text-[10px] text-muted-foreground">
                {research.title}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}
