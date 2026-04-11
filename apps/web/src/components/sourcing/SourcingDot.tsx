/**
 * SourcingDot — Unified colored dot for sourcing status.
 *
 * A small colored dot indicating the sourcing state of a data record or fact.
 * Designed to be compact enough for table cells and inline use.
 *
 * Color scheme (5 states):
 *   White  — Not run (check hasn't been executed yet)
 *   Black  — Error (system error, check couldn't complete)
 *   Red    — Failed (checked but couldn't verify the claim)
 *   Orange — Trouble (partially verified or concerns found)
 *   Green  — Verified (successfully verified)
 *
 * Used in both TableBase tables (personnel, grants, funding programs, etc.)
 * and FactBase fact displays.
 */

import Link from "next/link";

import {
  SOURCE_CHECK_STATUS_CONFIG,
  type SourcingStatus,
} from "./sourcing-status";

interface SourcingDotProps {
  /** The unified status to display */
  status: SourcingStatus;
  /** Optional: when the check was last run (ISO string) */
  lastChecked?: string | null;
  /** Optional: source URL that was checked */
  sourceUrl?: string | null;
  /** Optional: error message if status is "error" */
  error?: string | null;
  /** Optional: original verdict string for additional context */
  originalVerdict?: string | null;
  /** Dot size: sm = 6px (inline), md = 8px (table cell) */
  size?: "sm" | "md";
  /** Link to sourcing detail page. When provided, the element becomes clickable. */
  href?: string;
  className?: string;
}

function buildTooltip({
  status,
  lastChecked,
  sourceUrl,
  error,
  originalVerdict,
}: Pick<
  SourcingDotProps,
  "status" | "lastChecked" | "sourceUrl" | "error" | "originalVerdict"
>): string {
  const config = SOURCE_CHECK_STATUS_CONFIG[status];
  const parts: string[] = [config.label];

  if (originalVerdict && originalVerdict !== status) {
    parts.push(`Verdict: ${originalVerdict}`);
  }

  if (lastChecked) {
    try {
      const date = new Date(lastChecked);
      if (!isNaN(date.getTime())) {
        parts.push(`Checked: ${date.toLocaleDateString()}`);
      }
    } catch {
      // Invalid date, skip
    }
  }

  if (error) {
    parts.push(`Error: ${error}`);
  }

  if (sourceUrl) {
    try {
      const domain = new URL(sourceUrl).hostname.replace(/^www\./, "");
      parts.push(`Source: ${domain}`);
    } catch {
      parts.push(`Source: ${sourceUrl}`);
    }
  }

  return parts.join("\n");
}

export function SourcingDot({
  status,
  lastChecked,
  sourceUrl,
  error,
  originalVerdict,
  size = "sm",
  href,
  className = "",
}: SourcingDotProps) {
  const config = SOURCE_CHECK_STATUS_CONFIG[status];
  const dotSize = size === "md" ? "w-[7px] h-[7px]" : "w-1.5 h-1.5";
  const tooltip = buildTooltip({
    status,
    lastChecked,
    sourceUrl,
    error,
    originalVerdict,
  });

  const dot = (
    <span
      className={`inline-flex items-center shrink-0 ${className}`}
      title={tooltip}
    >
      <span
        className={`inline-block ${dotSize} rounded-full shrink-0 ${config.dotColor} ${config.borderColor}`}
      />
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="p-0.5 -m-0.5 rounded-full hover:bg-muted/50 transition-colors"
      >
        {dot}
      </Link>
    );
  }

  return dot;
}
