/**
 * CoverageDots — Pie-chart coverage indicator for entity content depth.
 *
 * Renders a single small circle partially filled (like a pie chart)
 * to show data completeness. Score 1-4 maps to 25%-100% fill.
 * Gray filled portion + lighter gray unfilled portion.
 */

interface CoverageDotsProps {
  /** Score from 1-4 (fill level: 1=25%, 2=50%, 3=75%, 4=100%) */
  score: number;
  /** Accessible label describing the score */
  label?: string;
  /** Tooltip text (shown on hover) */
  tooltip?: string;
  /** Circle size: sm = 7px (table rows), md = 9px (cards/headers) */
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
  const pct = clampedScore * 25; // 25%, 50%, 75%, 100%
  const dim = size === "md" ? 7 : 6;
  const ariaLabel = label ?? `Coverage: ${pct}%`;

  return (
    <span
      className={`inline-flex items-center shrink-0 ${className}`}
      role="img"
      aria-label={ariaLabel}
      title={tooltip ?? ariaLabel}
    >
      <span
        className="inline-block shrink-0 rounded-full"
        style={{
          width: dim,
          height: dim,
          background:
            pct >= 100
              ? "color-mix(in srgb, currentColor 45%, transparent)"
              : `conic-gradient(color-mix(in srgb, currentColor 45%, transparent) 0% ${pct}%, color-mix(in srgb, currentColor 12%, transparent) ${pct}% 100%)`,
        }}
      />
    </span>
  );
}
