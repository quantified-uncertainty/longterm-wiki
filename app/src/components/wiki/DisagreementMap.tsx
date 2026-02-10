import React from "react";
import { cn } from "@lib/utils";

interface Position {
  actor?: string;
  person?: string;
  position: string;
  estimate?: string;
  confidence?: string;
  reasoning?: string;
}

interface Spectrum {
  low: string;
  high: string;
}

interface DisagreementMapProps {
  topic: string;
  description?: string;
  spectrum?: Spectrum;
  positions: Position[];
  className?: string;
  "client:load"?: boolean;
}

const confidenceColors: Record<string, string> = {
  high: "border-l-red-500",
  "medium-high": "border-l-orange-500",
  medium: "border-l-yellow-500",
  "low-medium": "border-l-blue-400",
  low: "border-l-slate-400",
};

export function DisagreementMap({
  topic,
  description,
  spectrum,
  positions,
  className,
}: DisagreementMapProps) {
  if (!positions || positions.length === 0) return null;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-sm font-semibold mb-1">{topic}</h3>
      {description && (
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
      )}
      {spectrum && (
        <div className="flex justify-between text-[10px] text-muted-foreground mb-3 px-1">
          <span>{spectrum.low}</span>
          <span>{spectrum.high}</span>
        </div>
      )}
      <div className="space-y-2">
        {positions.map((pos, i) => {
          const name = pos.actor || pos.person || "Unknown";
          const borderColor = pos.confidence
            ? confidenceColors[pos.confidence] || "border-l-slate-300"
            : "border-l-slate-300";

          return (
            <div
              key={i}
              className={cn("rounded border-l-4 bg-muted/30 p-3", borderColor)}
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="font-medium text-sm">{name}</span>
                {pos.position && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {pos.position}
                  </span>
                )}
              </div>
              {pos.estimate && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {pos.estimate}
                </p>
              )}
              {pos.reasoning && (
                <p className="text-xs text-muted-foreground leading-relaxed mt-1 italic">
                  {pos.reasoning}
                </p>
              )}
              {pos.confidence && (
                <div className="mt-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    Confidence: {pos.confidence}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
