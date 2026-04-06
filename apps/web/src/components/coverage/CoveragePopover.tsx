"use client";

/**
 * CoveragePopover — Wraps CoverageDots with a click popover showing
 * score breakdown and signal details.
 */

import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { CoverageDots } from "./CoverageDots";

const SCORE_LABELS: Record<number, string> = {
  1: "Stub",
  2: "Basic",
  3: "Moderate",
  4: "Comprehensive",
};

interface CoveragePopoverProps {
  /** Score from 1-4 */
  score: number;
  /** List of signals that contributed to the score */
  signals?: string[];
  /** Dot size */
  size?: "sm" | "md";
  className?: string;
}

export function CoveragePopover({
  score,
  signals,
  size = "sm",
  className,
}: CoveragePopoverProps) {
  const clamped = Math.max(1, Math.min(4, Math.round(score)));
  const label = SCORE_LABELS[clamped] ?? "Unknown";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex cursor-default hover:opacity-80 transition-opacity ${className ?? ""}`}
          aria-label={`Coverage: ${label} (${clamped}/4)`}
        >
          <CoverageDots score={score} size={size} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">
              Coverage: {label}
            </span>
            <CoverageDots score={score} size="md" />
          </div>

          {signals && signals.length > 0 && (
            <div className="border-t border-border/50 pt-2">
              <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">
                Data signals detected
              </p>
              <ul className="space-y-0.5">
                {signals.map((signal) => (
                  <li
                    key={signal}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span className="w-1 h-1 rounded-full bg-primary/70 shrink-0" />
                    {signal}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground/50 border-t border-border/50 pt-1.5">
            {clamped === 1
              ? "This entity has minimal structured data."
              : clamped === 4
                ? "This entity has comprehensive structured data."
                : signals && signals.length > 0
                  ? `${signals.length} data signals detected.`
                  : "This entity has partial structured data."}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
