/**
 * RecordVerificationDot — Small colored dot for source-check verification status.
 *
 * Used in table cells and inline with record names to indicate whether
 * a structured record (grant, personnel, etc.) has been source-checked.
 *
 * Uses the source-check vocabulary (confirmed, contradicted, outdated, partial, unverifiable),
 * which is separate from the citation/FactBase vocabulary (accurate, minor_issues, etc.)
 * used by VerificationDot.tsx.
 */

import {
  SOURCE_CHECK_VERDICT_CONFIG,
  type SourceCheckVerdict,
} from "./verdict-config";

interface RecordVerificationDotProps {
  verdict: SourceCheckVerdict | null;
  /** Show the label text next to the dot (default: false) */
  showLabel?: boolean;
  /** Dot size: sm = 1.5px (inline), md = 2px (table cell) */
  size?: "sm" | "md";
  className?: string;
}

export function RecordVerificationDot({
  verdict,
  showLabel = false,
  size = "sm",
  className = "",
}: RecordVerificationDotProps) {
  if (!verdict) return null;

  const config = SOURCE_CHECK_VERDICT_CONFIG[verdict];
  if (!config) return null;

  const dotSize = size === "md" ? "w-2 h-2" : "w-1.5 h-1.5";

  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      title={config.label}
    >
      <span
        className={`inline-block ${dotSize} rounded-full shrink-0 ${config.color}`}
      />
      {showLabel && (
        <span className={`text-[10px] ${config.textColor}`}>
          {config.label}
        </span>
      )}
    </span>
  );
}
