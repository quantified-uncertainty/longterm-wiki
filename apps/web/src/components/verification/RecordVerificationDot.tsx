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

import Link from "next/link";

import {
  SOURCE_CHECK_VERDICT_CONFIG,
  type SourceCheckVerdict,
  type VerdictDisplayConfig,
} from "./verdict-config";

interface RecordVerificationDotProps {
  /** Verdict string from the API. Unknown values (including "unchecked") render nothing. */
  verdict: string | null | undefined;
  /** Show the label text next to the dot (default: false) */
  showLabel?: boolean;
  /** Dot size: sm = w-2 (8px), md = w-2.5 (10px) */
  size?: "sm" | "md";
  /** Link to source-check detail page. When provided, the dot becomes clickable. */
  href?: string;
  className?: string;
}

export function RecordVerificationDot({
  verdict,
  showLabel = false,
  size = "sm",
  href,
  className = "",
}: RecordVerificationDotProps) {
  const UNVERIFIED_CONFIG: VerdictDisplayConfig = {
    color: "bg-muted-foreground/30",
    label: "Unverified",
    textColor: "text-muted-foreground/60",
  };

  const config = verdict
    ? SOURCE_CHECK_VERDICT_CONFIG[verdict as SourceCheckVerdict]
    : UNVERIFIED_CONFIG;
  if (!config) return null; // Unknown verdict (e.g., "unchecked") — render nothing

  const dotSize = size === "md" ? "w-2.5 h-2.5" : "w-2 h-2";

  const dot = (
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

  if (href) {
    return <Link href={href} className="p-0.5 -m-0.5 rounded-full hover:bg-muted/50 transition-colors">{dot}</Link>;
  }

  return dot;
}
