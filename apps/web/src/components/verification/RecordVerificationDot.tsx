"use client";

/**
 * RecordVerificationDot — Small colored dot indicating source-check verification status.
 *
 * Client component. Uses Radix HoverCard for rich tooltip on hover.
 * For source-check verdicts (confirmed/contradicted/outdated/partial/unverifiable).
 *
 * Color scheme:
 *   emerald = confirmed (verified)
 *   red     = contradicted
 *   amber   = outdated
 *   blue    = partial
 *   gray    = unverifiable
 */

import * as HoverCard from "@radix-ui/react-hover-card";
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

// ── Verdict type & config ───────────────────────────────────────────

export type SourceCheckVerdict =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable";

interface VerdictConfig {
  dotColor: string;
  textColor: string;
  bgColor: string;
  label: string;
  Icon: LucideIcon;
}

const VERDICT_CONFIG: Record<SourceCheckVerdict, VerdictConfig> = {
  confirmed: {
    dotColor: "bg-emerald-500",
    textColor: "text-emerald-700 dark:text-emerald-400",
    bgColor: "bg-emerald-500/10",
    label: "Verified",
    Icon: CheckCircle2,
  },
  contradicted: {
    dotColor: "bg-red-500",
    textColor: "text-red-700 dark:text-red-400",
    bgColor: "bg-red-500/10",
    label: "Contradicted",
    Icon: XCircle,
  },
  outdated: {
    dotColor: "bg-amber-500",
    textColor: "text-amber-700 dark:text-amber-400",
    bgColor: "bg-amber-500/10",
    label: "Outdated",
    Icon: Clock,
  },
  partial: {
    dotColor: "bg-blue-400",
    textColor: "text-blue-700 dark:text-blue-400",
    bgColor: "bg-blue-500/10",
    label: "Partial",
    Icon: AlertCircle,
  },
  unverifiable: {
    dotColor: "bg-muted-foreground/40",
    textColor: "text-muted-foreground",
    bgColor: "bg-muted/50",
    label: "Unverifiable",
    Icon: HelpCircle,
  },
};

// ── Verification info type (matches API response shape) ─────────────

export interface VerificationInfo {
  verdict: string | null;
  confidence: number | null;
  sourcesChecked: number;
  checkedAt: string | null;
}

// ── Component ───────────────────────────────────────────────────────

interface RecordVerificationDotProps {
  verification: VerificationInfo | null | undefined;
  className?: string;
}

export function RecordVerificationDot({
  verification,
  className = "",
}: RecordVerificationDotProps) {
  if (!verification?.verdict) return null;

  const config = VERDICT_CONFIG[verification.verdict as SourceCheckVerdict];
  if (!config) return null;

  const { Icon } = config;

  return (
    <HoverCard.Root openDelay={200} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 cursor-default ${config.dotColor} ${className}`}
        />
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="z-50 w-56 rounded-lg border border-border bg-popover p-3 shadow-lg animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
          sideOffset={5}
          align="center"
        >
          <div className="space-y-2">
            {/* Verdict header */}
            <div className={`flex items-center gap-1.5 ${config.textColor}`}>
              <Icon className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold">{config.label}</span>
              {verification.confidence != null && (
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {Math.round(verification.confidence * 100)}%
                </span>
              )}
            </div>

            {/* Details */}
            <div className="text-[10px] text-muted-foreground space-y-0.5">
              {verification.sourcesChecked > 0 && (
                <div>
                  {verification.sourcesChecked} source
                  {verification.sourcesChecked !== 1 ? "s" : ""} checked
                </div>
              )}
              {verification.checkedAt && (
                <div>
                  Checked{" "}
                  {new Date(verification.checkedAt).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                </div>
              )}
            </div>
          </div>
          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
