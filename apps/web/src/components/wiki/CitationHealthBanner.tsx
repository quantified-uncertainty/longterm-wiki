"use client";

import { CheckCircle2, AlertTriangle, XCircle, ShieldCheck } from "lucide-react";
import type { CitationHealthSummary } from "./CitationOverlay";

interface CitationHealthBannerProps {
  health: CitationHealthSummary;
}

/**
 * Page-level banner showing aggregate citation verification health.
 * Displayed below the ContentConfidenceBanner for pages with verified citations.
 */
export function CitationHealthBanner({ health }: CitationHealthBannerProps) {
  if (health.total === 0) return null;

  const checked = health.accurate + health.inaccurate + health.unsupported + health.minorIssues;
  const problems = health.inaccurate + health.unsupported;
  const goodCount = health.accurate + health.minorIssues + health.verified;

  // Determine banner style based on health
  const hasProblems = problems > 0;
  const allGood = checked > 0 && problems === 0;

  const borderColor = hasProblems
    ? "border-amber-500/30"
    : "border-emerald-500/20";
  const bgColor = hasProblems
    ? "bg-amber-500/5"
    : "bg-emerald-500/5";
  const textColor = hasProblems
    ? "text-amber-900 dark:text-amber-200"
    : "text-emerald-900 dark:text-emerald-200";

  const Icon = hasProblems ? AlertTriangle : ShieldCheck;
  const iconColor = hasProblems ? "text-amber-500" : "text-emerald-500";

  return (
    <div
      className={`my-3 rounded-lg border ${borderColor} ${bgColor} px-4 py-2.5 text-sm ${textColor}`}
      data-citation-health={hasProblems ? "issues" : "good"}
    >
      <div className="flex items-center gap-2.5 flex-wrap">
        <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
        <span className="font-medium text-xs">
          Citations verified
        </span>
        <span className="text-xs opacity-80">
          {goodCount > 0 && (
            <span className="inline-flex items-center gap-1 mr-2">
              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
              {goodCount} accurate
            </span>
          )}
          {problems > 0 && (
            <span className="inline-flex items-center gap-1 mr-2">
              <XCircle className="w-3 h-3 text-red-500" />
              {problems} flagged
            </span>
          )}
          {health.unchecked > 0 && (
            <span className="opacity-60">
              {health.unchecked} unchecked
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
