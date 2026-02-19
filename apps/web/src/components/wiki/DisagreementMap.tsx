import React from "react";
import { cn } from "@lib/utils";

/**
 * DisagreementMap — shows different positions on a contested topic.
 *
 * Used across ~25 MDX files with two main position schemas:
 *
 * Schema A (majority): { name, description, proponents, strength }
 * Schema B (~6 files): { actor|person, position, confidence, reasoning, estimate }
 *
 * Some debate pages also pass: stance, evidence, quote.
 * Header is `topic` in most files, `title` in some debate pages.
 */

interface Position {
  // Identity — Schema A uses `name`, Schema B uses `actor` or `person`
  name?: string;
  actor?: string;
  person?: string;

  // Position text — Schema B uses `position` or `stance`
  position?: string;
  stance?: string;

  // Detail — Schema A uses `description`, Schema B uses `estimate`
  description?: string;
  estimate?: string;

  // Confidence — Schema A uses `strength` (number 1-5), Schema B uses `confidence` (string)
  confidence?: string;
  strength?: number;

  // Reasoning (Schema B)
  reasoning?: string;

  // Proponents list (Schema A)
  proponents?: string[];

  // Extra fields from some debate pages
  evidence?: string[];
  quote?: string;
}

interface Spectrum {
  low: string;
  high: string;
}

interface DisagreementMapProps {
  topic?: string;
  title?: string;
  description?: string;
  spectrum?: Spectrum;
  positions: Position[];
  className?: string;
  "client:load"?: boolean;
}

function getLabel(pos: Position): string {
  return pos.actor || pos.person || pos.name || "Unknown";
}

function getPositionText(pos: Position): string | undefined {
  return pos.position || pos.stance;
}

function getDetail(pos: Position): string | undefined {
  return pos.estimate || pos.description;
}

function getConfidenceLabel(pos: Position): string | undefined {
  if (pos.confidence) return pos.confidence;
  if (pos.strength != null) {
    if (pos.strength >= 4) return "high";
    if (pos.strength >= 3) return "medium";
    return "low";
  }
  return undefined;
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
  title,
  description,
  spectrum,
  positions,
  className,
}: DisagreementMapProps) {
  if (!positions || positions.length === 0) return null;

  const heading = topic || title;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      {heading && <h3 className="text-sm font-semibold mb-1">{heading}</h3>}
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
          const label = getLabel(pos);
          const posText = getPositionText(pos);
          const detail = getDetail(pos);
          const confLabel = getConfidenceLabel(pos);
          const borderColor = confLabel
            ? confidenceColors[confLabel] || "border-l-slate-300"
            : "border-l-slate-300";

          return (
            <div
              key={i}
              className={cn("rounded border-l-4 bg-muted/30 p-3", borderColor)}
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="font-medium text-sm">{label}</span>
                {posText && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {posText}
                  </span>
                )}
              </div>
              {detail && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {detail}
                </p>
              )}
              {pos.reasoning && (
                <p className="text-xs text-muted-foreground leading-relaxed mt-1 italic">
                  {pos.reasoning}
                </p>
              )}
              {pos.proponents && pos.proponents.length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  Proponents: {pos.proponents.join(", ")}
                </div>
              )}
              {pos.evidence && pos.evidence.length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  Evidence: {pos.evidence.join("; ")}
                </div>
              )}
              {pos.quote && (
                <blockquote className="text-[10px] text-muted-foreground mt-1 border-l-2 border-muted pl-2 italic">
                  &ldquo;{pos.quote}&rdquo;
                </blockquote>
              )}
              {confLabel && (
                <div className="mt-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    Confidence: {confLabel}
                    {pos.strength != null && ` (${pos.strength}/5)`}
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
