/**
 * RecordVerificationDot — Verification status indicator for source-checked records.
 *
 * Two display variants:
 * - "dot" (default): Small colored dot, used inline with record names
 * - "label": Colored text label, used as a dedicated column in tables
 *
 * For "never checked" (verdict=null):
 * - dot variant: hollow circle with "Not checked" tooltip
 * - label variant: renders nothing (blank = unambiguous "not checked")
 *
 * Uses the source-check vocabulary (confirmed, contradicted, outdated, partial, unverifiable),
 * which is separate from the citation/FactBase vocabulary used by VerificationDot.tsx.
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
  /** Display variant: "dot" for inline dots, "label" for text column */
  variant?: "dot" | "label";
  /** Show the label text next to the dot (default: false). Only applies to dot variant. */
  showLabel?: boolean;
  /** Dot size: sm = w-2 (8px), md = w-2.5 (10px). Only applies to dot variant. */
  size?: "sm" | "md";
  /** Link to source-check detail page. When provided, the element becomes clickable. */
  href?: string;
  className?: string;
}

export function RecordVerificationDot({
  verdict,
  variant = "dot",
  showLabel = false,
  size = "sm",
  href,
  className = "",
}: RecordVerificationDotProps) {
  const config = verdict
    ? SOURCE_CHECK_VERDICT_CONFIG[verdict as SourceCheckVerdict]
    : null;

  // Label variant: render text for known verdicts, nothing for unchecked
  if (variant === "label") {
    if (!config) return null;
    const label = (
      <span className={`text-xs font-medium ${config.textColor} ${className}`}>
        {config.label}
      </span>
    );
    if (href) {
      return (
        <Link href={href} className="hover:underline transition-colors">
          {label}
        </Link>
      );
    }
    return label;
  }

  // Dot variant (original behavior)
  const UNVERIFIED_CONFIG: VerdictDisplayConfig = {
    color: "border border-muted-foreground/40",
    label: "Not checked",
    textColor: "text-muted-foreground/60",
  };

  const dotConfig = config ?? UNVERIFIED_CONFIG;
  const dotSize = size === "md" ? "w-2.5 h-2.5" : "w-2 h-2";

  const dot = (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      title={dotConfig.label}
    >
      <span
        className={`inline-block ${dotSize} rounded-full shrink-0 ${dotConfig.color}`}
      />
      {showLabel && (
        <span className={`text-[10px] ${dotConfig.textColor}`}>
          {dotConfig.label}
        </span>
      )}
    </span>
  );

  if (href) {
    return <Link href={href} className="p-0.5 -m-0.5 rounded-full hover:bg-muted/50 transition-colors">{dot}</Link>;
  }

  return dot;
}
