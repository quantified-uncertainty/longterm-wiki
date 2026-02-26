"use client";

import { cn } from "@lib/utils";
import { useCitationQuotes } from "./CitationQuotesContext";
import { normalizeUrl, VERDICT_STYLES, VERDICT_SEVERITY, MAX_CLAIMS_SHOWN } from "./resource-utils";
import type { CitationQuote } from "@/lib/citation-data";
import { renderInlineMarkdown } from "@/lib/inline-markdown";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, Clock, ExternalLink } from "lucide-react";
import { isSafeUrl } from "./CitationOverlay";
import Link from "next/link";

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

/** Icon per verdict — only needed in claim rows, not shared */
const VERDICT_ICONS: Record<string, typeof CheckCircle2> = {
  accurate: CheckCircle2,
  minor_issues: AlertTriangle,
  inaccurate: XCircle,
  unsupported: XCircle,
  not_verifiable: HelpCircle,
};

function ClaimRow({ quote, pageId }: { quote: CitationQuote; pageId?: string }) {
  const verdict = quote.accuracyVerdict;
  const info = verdict ? VERDICT_STYLES[verdict] : null;
  const Icon = (verdict ? VERDICT_ICONS[verdict] : null) ?? (quote.quoteVerified ? CheckCircle2 : null);
  const color = info?.color ?? (quote.quoteVerified ? "text-blue-600" : "text-muted-foreground");
  const bg = info?.bg ?? (quote.quoteVerified ? "bg-blue-500/10" : "");
  const label = info?.label ?? (quote.quoteVerified ? "Verified" : null);
  const score = quote.accuracyScore;

  // Show the source quote if available; otherwise fall back to accuracy issues or a generic label
  const sourceQuoteText = quote.sourceQuote;
  const verificationText = quote.accuracyIssues || (
    verdict === "accurate" && !sourceQuoteText ? "Supported by source" :
    quote.quoteVerified && !sourceQuoteText ? "Quote verified" :
    null
  );

  const checkedAt = quote.accuracyCheckedAt ?? quote.verifiedAt;

  return (
    <div className="py-2 border-b border-border/30 last:border-b-0">
      {/* Claim text */}
      <div className="text-[12px] text-foreground/90 leading-relaxed mb-1.5">
        {renderInlineMarkdown(quote.claimText)}
      </div>
      {/* Verification result */}
      <div className="flex items-center gap-2 flex-wrap">
        {Icon && label && (
          <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium", color, bg)}>
            <Icon className="w-3 h-3 shrink-0" />
            {label}
            {score != null && (
              <span className="opacity-60 ml-0.5">{Math.round(score * 100)}%</span>
            )}
          </span>
        )}
        {checkedAt && (
          <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5">
            <Clock className="w-2.5 h-2.5 shrink-0" />
            {formatDate(checkedAt)}
          </span>
        )}
      </div>
      {/* Source quote — shown if available instead of generic "supported by source" */}
      {sourceQuoteText && (
        <blockquote className="text-[11px] text-muted-foreground/80 border-l-2 border-border/50 pl-2 mt-1.5 leading-relaxed italic line-clamp-3">
          &ldquo;{sourceQuoteText}&rdquo;
        </blockquote>
      )}
      {/* Accuracy issues (shown alongside quote when both exist) */}
      {verificationText && (
        <p className="text-[11px] text-muted-foreground/70 m-0 mt-1">
          {verificationText}
        </p>
      )}
    </div>
  );
}

/**
 * Client component that reads citation quote data from context and renders
 * verification details for a specific resource URL in the expanded reference.
 *
 * Stacked layout: each claim shows its text, verdict badge, source quote,
 * and accuracy issues in a clean vertical arrangement.
 */
export function ReferenceCitationDetails({ url, pageId }: { url: string; pageId?: string }) {
  const quotes = useCitationQuotes();

  if (quotes.length === 0) return null;

  // Match all quotes that cite this URL
  const norm = normalizeUrl(url);
  const matching = quotes.filter((q) => q.url && normalizeUrl(q.url) === norm);
  if (matching.length === 0) return null;

  // Deduplicate by claim text (keep the entry with the best verdict data)
  const deduped = new Map<string, CitationQuote>();
  for (const q of matching) {
    const key = q.claimText.trim().toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, q);
    } else {
      const scoreExisting = (existing.accuracyVerdict ? 2 : 0) + (existing.accuracyIssues ? 1 : 0);
      const scoreNew = (q.accuracyVerdict ? 2 : 0) + (q.accuracyIssues ? 1 : 0);
      if (scoreNew > scoreExisting) deduped.set(key, q);
    }
  }
  const unique = [...deduped.values()];

  // Sort: problematic verdicts first, then accurate, then unverified
  const sorted = unique.sort((a, b) => {
    const va = a.accuracyVerdict ? (VERDICT_SEVERITY[a.accuracyVerdict] ?? 5) : 6;
    const vb = b.accuracyVerdict ? (VERDICT_SEVERITY[b.accuracyVerdict] ?? 5) : 6;
    return va - vb;
  });

  const shown = sorted.slice(0, MAX_CLAIMS_SHOWN);
  const remaining = sorted.length - shown.length;

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
          Claims ({sorted.length})
        </span>
        {pageId && (
          <Link
            href={`/claims/entity/${pageId}`}
            className="text-[10px] text-muted-foreground/50 hover:text-foreground transition-colors !no-underline"
          >
            View all claims
          </Link>
        )}
      </div>
      <div>
        {shown.map((q, i) => (
          <ClaimRow key={i} quote={q} pageId={pageId} />
        ))}
      </div>
      {remaining > 0 && (
        <span className="text-[11px] text-muted-foreground/50 block mt-1 pb-0.5">
          +{remaining} more claims
        </span>
      )}
    </div>
  );
}
