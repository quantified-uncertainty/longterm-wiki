/**
 * CoverageDots — Reusable dot-ladder indicator for entity content depth.
 *
 * Renders 1-4 filled/unfilled dots showing how much structured data,
 * relationships, and content exists for an entity. Entity-type-aware
 * scoring functions determine the score; this component just renders it.
 *
 * Visual language:
 *   Filled dots   — teal/primary, proportional to coverage
 *   Unfilled dots  — faint gray placeholder
 *
 * Designed to be compact enough for table cells and inline use,
 * following the same pattern as SourceCheckDot.
 */

interface CoverageDotsProps {
  /** Score from 1-4 (number of filled dots) */
  score: number;
  /** Accessible label describing the score */
  label?: string;
  /** Tooltip text (shown on hover) */
  tooltip?: string;
  /** Dot size: sm = 6px (table rows), md = 8px (cards/headers) */
  size?: "sm" | "md";
  className?: string;
}

export function CoverageDots({
  score,
  label,
  tooltip,
  size = "sm",
  className = "",
}: CoverageDotsProps) {
  const clampedScore = Math.max(1, Math.min(4, Math.round(score)));
  const dotSize = size === "md" ? "w-2 h-2" : "w-1.5 h-1.5";
  const ariaLabel = label ?? `Coverage: ${clampedScore} of 4`;

  return (
    <span
      className={`inline-flex gap-0.5 ${className}`}
      role="img"
      aria-label={ariaLabel}
      title={tooltip}
    >
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`inline-block ${dotSize} rounded-full ${
            i <= clampedScore
              ? "bg-primary/70"
              : "bg-muted-foreground/20"
          }`}
        />
      ))}
    </span>
  );
}
