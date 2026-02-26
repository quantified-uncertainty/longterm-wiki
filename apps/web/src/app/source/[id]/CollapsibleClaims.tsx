"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  BookOpen,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@lib/utils";
import { renderInlineMarkdown } from "@/lib/inline-markdown";

const VERDICT_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; label: string; color: string; bg: string }
> = {
  accurate: {
    icon: CheckCircle2,
    label: "Accurate",
    color: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
  minor_issues: {
    icon: AlertTriangle,
    label: "Minor issues",
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
  },
  inaccurate: {
    icon: XCircle,
    label: "Inaccurate",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
  },
  unsupported: {
    icon: XCircle,
    label: "Unsupported",
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
  },
  not_verifiable: {
    icon: HelpCircle,
    label: "Not verifiable",
    color: "text-muted-foreground",
    bg: "bg-muted/30",
  },
};

interface Quote {
  pageId: string;
  claimText: string;
  sourceQuote?: string | null;
  accuracyVerdict?: string | null;
  accuracyScore?: number | null;
  accuracyIssues?: string | null;
  accuracyCheckedAt?: string | null;
}

interface PageGroup {
  pageId: string;
  pageTitle: string;
  pageHref: string;
  quotes: Quote[];
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Number of page groups to show before requiring "Show all" */
const INITIAL_VISIBLE_GROUPS = 3;

export function CollapsibleClaims({
  pageGroups,
  totalClaims,
}: {
  pageGroups: PageGroup[];
  totalClaims: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const visibleGroups =
    showAll || pageGroups.length <= INITIAL_VISIBLE_GROUPS
      ? pageGroups
      : pageGroups.slice(0, INITIAL_VISIBLE_GROUPS);

  const hiddenGroupCount = pageGroups.length - INITIAL_VISIBLE_GROUPS;

  // Count verdicts for the summary
  const verdictCounts: Record<string, number> = {};
  for (const group of pageGroups) {
    for (const q of group.quotes) {
      const v = q.accuracyVerdict ?? "unchecked";
      verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    }
  }

  return (
    <section className="mb-8">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full text-left group"
      >
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
          Claims from Wiki Pages
        </h2>
        <span className="text-xs text-muted-foreground/70 ml-1">
          {totalClaims} claim{totalClaims !== 1 ? "s" : ""} across{" "}
          {pageGroups.length} page{pageGroups.length !== 1 ? "s" : ""}
        </span>
      </button>

      {/* Compact summary when collapsed */}
      {!isOpen && (
        <div className="mt-2 ml-6 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {verdictCounts.accurate && verdictCounts.accurate > 0 && (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" />
              {verdictCounts.accurate} accurate
            </span>
          )}
          {((verdictCounts.minor_issues ?? 0) > 0 ||
            (verdictCounts.inaccurate ?? 0) > 0 ||
            (verdictCounts.unsupported ?? 0) > 0) && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {(verdictCounts.minor_issues ?? 0) +
                (verdictCounts.inaccurate ?? 0) +
                (verdictCounts.unsupported ?? 0)}{" "}
              flagged
            </span>
          )}
          {verdictCounts.not_verifiable && verdictCounts.not_verifiable > 0 && (
            <span className="inline-flex items-center gap-1">
              <HelpCircle className="w-3 h-3" />
              {verdictCounts.not_verifiable} not verifiable
            </span>
          )}
        </div>
      )}

      {/* Expanded content */}
      {isOpen && (
        <div className="mt-3">
          {visibleGroups.map((group) => (
            <div
              key={group.pageId}
              className="mb-4 border border-border rounded-lg overflow-hidden"
            >
              <div className="px-4 py-2 bg-muted/50 border-b border-border">
                <Link
                  href={group.pageHref}
                  className="text-sm font-medium text-accent-foreground hover:underline"
                >
                  {group.pageTitle}
                </Link>
                <span className="text-xs text-muted-foreground ml-2">
                  {group.quotes.length} claim
                  {group.quotes.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="divide-y divide-border">
                {group.quotes.map((q, i) => {
                  const verdict = q.accuracyVerdict
                    ? VERDICT_CONFIG[q.accuracyVerdict]
                    : null;
                  const Icon = verdict?.icon;

                  return (
                    <div key={i} className={cn("px-4 py-2.5", verdict?.bg)}>
                      <p className="text-sm text-foreground leading-snug mb-1">
                        {renderInlineMarkdown(q.claimText)}
                      </p>

                      {q.sourceQuote && (
                        <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 mb-1.5 italic leading-snug line-clamp-2">
                          &ldquo;{q.sourceQuote}&rdquo;
                        </blockquote>
                      )}

                      <div className="flex items-center gap-2 text-xs">
                        {verdict && Icon && (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1",
                              verdict.color
                            )}
                          >
                            <Icon className="w-3 h-3" />
                            {verdict.label}
                          </span>
                        )}
                        {q.accuracyScore != null && (
                          <span className="text-muted-foreground tabular-nums">
                            {Math.round(q.accuracyScore * 100)}%
                          </span>
                        )}
                        {q.accuracyIssues && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {q.accuracyIssues}
                          </span>
                        )}
                        {q.accuracyCheckedAt && (
                          <span className="text-muted-foreground/60 ml-auto flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDate(q.accuracyCheckedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Show more / Show less toggle */}
          {pageGroups.length > INITIAL_VISIBLE_GROUPS && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
            >
              {showAll
                ? "Show fewer pages"
                : `Show ${hiddenGroupCount} more page${hiddenGroupCount !== 1 ? "s" : ""}...`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
