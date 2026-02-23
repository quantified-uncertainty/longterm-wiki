"use client";

import { cn } from "@lib/utils";
import { useCitationQuotes } from "./CitationQuotesContext";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";

const VERDICT_STYLES: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  accurate: { icon: CheckCircle2, color: "text-emerald-600", label: "Verified accurate" },
  minor_issues: { icon: AlertTriangle, color: "text-amber-600", label: "Minor issues" },
  inaccurate: { icon: XCircle, color: "text-red-600", label: "Inaccurate" },
  unsupported: { icon: XCircle, color: "text-red-500", label: "Unsupported" },
  not_verifiable: { icon: HelpCircle, color: "text-muted-foreground", label: "Not verifiable" },
};

/** Normalize a URL for fuzzy matching (strip trailing slash, www, protocol) */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Client component that reads citation quote data from context and renders
 * verification details for a specific resource URL in the expanded reference.
 */
export function ReferenceCitationDetails({ url }: { url: string }) {
  const quotes = useCitationQuotes();

  if (quotes.length === 0) return null;

  // Match quotes by normalized URL
  const norm = normalizeUrl(url);
  const matching = quotes.filter((q) => q.url && normalizeUrl(q.url) === norm);
  if (matching.length === 0) return null;

  // Pick the most informative quote (prefer one with accuracy verdict and source quote)
  const best = matching.sort((a, b) => {
    const scoreA = (a.accuracyVerdict ? 2 : 0) + (a.sourceQuote ? 1 : 0);
    const scoreB = (b.accuracyVerdict ? 2 : 0) + (b.sourceQuote ? 1 : 0);
    return scoreB - scoreA;
  })[0];

  const verdictInfo = best.accuracyVerdict
    ? VERDICT_STYLES[best.accuracyVerdict]
    : best.quoteVerified
      ? { icon: CheckCircle2, color: "text-blue-500", label: "Source verified" }
      : null;

  const hasContent = verdictInfo || best.sourceQuote || best.claimText;
  if (!hasContent) return null;

  const Icon = verdictInfo?.icon;

  return (
    <div className="mt-2 pt-2 border-t border-border">
      {/* Verdict badge */}
      {verdictInfo && Icon && (
        <span className={cn("inline-flex items-center gap-1 text-xs mb-1", verdictInfo.color)}>
          <Icon className="w-3 h-3" />
          {verdictInfo.label}
          {best.accuracyScore != null && (
            <span className="text-muted-foreground ml-0.5">
              ({Math.round(best.accuracyScore * 100)}%)
            </span>
          )}
        </span>
      )}

      {/* Source quote — clamped to 2 lines to avoid dominating the section */}
      {best.sourceQuote && best.sourceQuote.length > 30 && (
        <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2 my-1.5 italic leading-relaxed line-clamp-2">
          &ldquo;{best.sourceQuote}&rdquo;
        </blockquote>
      )}

      {/* Accuracy issues — truncated, subtle styling */}
      {best.accuracyIssues && (
        <p className="text-xs text-muted-foreground m-0 mt-1 leading-relaxed line-clamp-3">
          {best.accuracyIssues}
        </p>
      )}

      {/* How many claims cite this source */}
      {matching.length > 1 && (
        <span className="text-xs text-muted-foreground opacity-60 mt-1.5 block">
          {matching.length} claims cite this source
        </span>
      )}
    </div>
  );
}
