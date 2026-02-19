import React from "react";
import { cn } from "@lib/utils";

interface CruxPosition {
  view: string;
  probability?: string;
  holders?: string[];
  implications?: string;
}

interface CruxResearch {
  title: string;
  url?: string;
}

interface CruxProps {
  id?: string;
  question: string;
  domain?: string;
  description?: string;
  importance?: string;
  resolvability?: string;
  currentState?: string;
  positions?: CruxPosition[];
  wouldUpdateOn?: string[];
  relatedCruxes?: string[];
  relevantResearch?: CruxResearch[];
  className?: string;
  "client:load"?: boolean;
}

const importanceBadge: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function Crux({
  question,
  domain,
  description,
  importance,
  resolvability,
  currentState,
  positions,
  wouldUpdateOn,
  relatedCruxes,
  relevantResearch,
  className,
}: CruxProps) {
  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h4 className="text-sm font-semibold leading-snug flex-1">{question}</h4>
        <div className="flex gap-1.5 shrink-0">
          {domain && (
            <span className="text-[10px] bg-muted rounded px-1.5 py-0.5 font-medium">
              {domain}
            </span>
          )}
          {importance && (
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 font-medium",
                importanceBadge[importance] || importanceBadge.medium
              )}
            >
              {importance}
            </span>
          )}
        </div>
      </div>

      {/* Description */}
      {description && (
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
      )}

      {/* Metadata row */}
      {(resolvability || currentState) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-3">
          {resolvability && (
            <span>Resolvability: <strong>{resolvability}</strong></span>
          )}
          {currentState && (
            <span>Current state: <strong>{currentState}</strong></span>
          )}
        </div>
      )}

      {/* Positions */}
      {positions && positions.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Positions
          </div>
          {positions.map((pos, i) => (
            <div key={i} className="border-l-2 border-muted pl-3 py-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium">{pos.view}</span>
                {pos.probability && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    ({pos.probability})
                  </span>
                )}
              </div>
              {pos.holders && pos.holders.length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Held by: {pos.holders.join(", ")}
                </div>
              )}
              {pos.implications && (
                <div className="text-[10px] text-muted-foreground mt-0.5 italic">
                  → {pos.implications}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Would update on */}
      {wouldUpdateOn && wouldUpdateOn.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Would update on
          </div>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {wouldUpdateOn.map((item, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="shrink-0">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related cruxes */}
      {relatedCruxes && relatedCruxes.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          <span className="text-[10px] text-muted-foreground mr-1">Related:</span>
          {relatedCruxes.map((crux) => (
            <span key={crux} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
              {crux}
            </span>
          ))}
        </div>
      )}

      {/* Relevant research */}
      {relevantResearch && relevantResearch.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {relevantResearch.map((research, i) => (
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
          ))}
        </div>
      )}
    </div>
  );
}
