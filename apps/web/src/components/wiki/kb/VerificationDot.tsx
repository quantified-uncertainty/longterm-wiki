/**
 * VerificationDot — Small colored dot indicating citation verification status.
 *
 * Server component. Used in KBFactValue tooltips and KBEntityFacts rows to show
 * whether a KB fact's source URL has been citation-verified.
 *
 * Color scheme matches CitationOverlay.tsx for consistency:
 *   green  = accurate
 *   amber  = minor_issues
 *   red    = inaccurate
 *   orange = unsupported
 *   gray   = not_verifiable
 *   blue   = verified (source confirmed, accuracy not checked)
 */

import type { KBFactVerdict } from "@data/factbase";

interface VerificationDotConfig {
  dotColor: string;
  label: string;
}

const VERDICT_CONFIG: Record<KBFactVerdict, VerificationDotConfig> = {
  accurate: {
    dotColor: "bg-emerald-500",
    label: "Verified accurate",
  },
  minor_issues: {
    dotColor: "bg-amber-500",
    label: "Minor issues",
  },
  inaccurate: {
    dotColor: "bg-red-500",
    label: "Inaccurate",
  },
  unsupported: {
    dotColor: "bg-red-400",
    label: "Unsupported",
  },
  not_verifiable: {
    dotColor: "bg-muted-foreground/40",
    label: "Not verifiable",
  },
  verified: {
    dotColor: "bg-blue-500",
    label: "Source verified",
  },
};

interface VerificationDotProps {
  verdict: KBFactVerdict;
  /** Show the label text next to the dot (default: false) */
  showLabel?: boolean;
  className?: string;
}

export function VerificationDot({
  verdict,
  showLabel = false,
  className = "",
}: VerificationDotProps) {
  const config = VERDICT_CONFIG[verdict];
  if (!config) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      title={config.label}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${config.dotColor}`}
      />
      {showLabel && (
        <span className="text-[10px] text-muted-foreground">{config.label}</span>
      )}
    </span>
  );
}
