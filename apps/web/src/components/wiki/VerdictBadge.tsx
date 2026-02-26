"use client";

import { cn } from "@lib/utils";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";

/**
 * Verdict display configuration.
 *
 * Uses the same canonical verdict keys as resource-utils.ts and CitationOverlay
 * but exposed as a standalone badge component for reuse in FootnoteTooltip
 * and the footnote definitions section.
 */

interface VerdictStyle {
  icon: typeof CheckCircle2;
  label: string;
  color: string;
  bg: string;
  iconColor: string;
}

const VERDICT_STYLES: Record<string, VerdictStyle> = {
  accurate: {
    icon: CheckCircle2,
    label: "Verified",
    color: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
    iconColor: "text-emerald-500",
  },
  minor_issues: {
    icon: AlertTriangle,
    label: "Minor Issues",
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-500/10",
    iconColor: "text-amber-500",
  },
  inaccurate: {
    icon: XCircle,
    label: "Disputed",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-500/10",
    iconColor: "text-red-500",
  },
  unsupported: {
    icon: XCircle,
    label: "Unsupported",
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-500/10",
    iconColor: "text-red-400",
  },
  not_verifiable: {
    icon: HelpCircle,
    label: "Unverified",
    color: "text-muted-foreground",
    bg: "bg-muted/50",
    iconColor: "text-muted-foreground",
  },
};

/** Fallback for citations that have been quote-verified but not accuracy-checked */
const VERIFIED_STYLE: VerdictStyle = {
  icon: CheckCircle2,
  label: "Source Verified",
  color: "text-blue-700 dark:text-blue-400",
  bg: "bg-blue-500/10",
  iconColor: "text-blue-500",
};

/** Default unverified style when no verdict data is available */
const UNVERIFIED_STYLE: VerdictStyle = {
  icon: HelpCircle,
  label: "Unverified",
  color: "text-muted-foreground",
  bg: "bg-muted/30",
  iconColor: "text-muted-foreground/50",
};

export type VerdictType =
  | "accurate"
  | "minor_issues"
  | "inaccurate"
  | "unsupported"
  | "not_verifiable"
  | "verified"
  | "unverified";

interface VerdictBadgeProps {
  /** Verdict key from the citation verification system */
  verdict?: string | null;
  /** Whether the source quote was verified (used as fallback when no accuracy verdict) */
  quoteVerified?: boolean;
  /** Accuracy confidence score (0-1), displayed as percentage when present */
  score?: number | null;
  /** Size variant */
  size?: "sm" | "md";
  /** Additional class name */
  className?: string;
}

/**
 * VerdictBadge -- small colored pill showing claim verification status.
 *
 * Renders a verdict icon + label with color coding:
 * - Green: "Verified" (accurate)
 * - Yellow: "Minor Issues" (minor_issues)
 * - Red: "Disputed" (inaccurate) or "Unsupported" (unsupported)
 * - Gray: "Unverified" (not_verifiable or no data)
 * - Blue: "Source Verified" (quote verified but no accuracy check)
 */
export function VerdictBadge({
  verdict,
  quoteVerified,
  score,
  size = "sm",
  className,
}: VerdictBadgeProps) {
  let style: VerdictStyle;

  if (verdict && VERDICT_STYLES[verdict]) {
    style = VERDICT_STYLES[verdict];
  } else if (quoteVerified) {
    style = VERIFIED_STYLE;
  } else {
    style = UNVERIFIED_STYLE;
  }

  const Icon = style.icon;
  const isSmall = size === "sm";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        style.color,
        style.bg,
        isSmall ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        className
      )}
    >
      <Icon
        className={cn(
          "shrink-0",
          style.iconColor,
          isSmall ? "w-2.5 h-2.5" : "w-3 h-3"
        )}
      />
      {style.label}
      {score != null && (
        <span className="opacity-60 ml-0.5 tabular-nums">
          {Math.round(score * 100)}%
        </span>
      )}
    </span>
  );
}

/**
 * Get the verdict style configuration for a given verdict key.
 * Useful when other components need to match colors without rendering the badge.
 */
export function getVerdictStyle(
  verdict?: string | null,
  quoteVerified?: boolean
): VerdictStyle {
  if (verdict && VERDICT_STYLES[verdict]) {
    return VERDICT_STYLES[verdict];
  }
  if (quoteVerified) {
    return VERIFIED_STYLE;
  }
  return UNVERIFIED_STYLE;
}
