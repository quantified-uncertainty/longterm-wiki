"use client";

import { cn } from "@lib/utils";
import { useCitationQuotes } from "./CitationQuotesContext";
import { normalizeUrl, VERDICT_STYLES, VERDICT_SEVERITY, MAX_CLAIMS_SHOWN } from "./resource-utils";
import type { CitationQuote } from "@/lib/citation-data";
import { renderInlineMarkdown } from "@/lib/inline-markdown";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";

/** Icon per verdict — only needed in claim rows, not shared */
const VERDICT_ICONS: Record<string, typeof CheckCircle2> = {
  accurate: CheckCircle2,
  minor_issues: AlertTriangle,
  inaccurate: XCircle,
  unsupported: XCircle,
  not_verifiable: HelpCircle,
};

function ClaimRow({ quote }: { quote: CitationQuote }) {
  const verdict = quote.accuracyVerdict;
  const info = verdict ? VERDICT_STYLES[verdict] : null;
  const Icon = (verdict ? VERDICT_ICONS[verdict] : null) ?? (quote.quoteVerified ? CheckCircle2 : null);
  const color = info?.color ?? (quote.quoteVerified ? "text-blue-600" : "text-muted-foreground");
  const bg = info?.bg ?? (quote.quoteVerified ? "bg-blue-500/10" : "");
  const label = info?.label ?? (quote.quoteVerified ? "Verified" : null);
  const score = quote.accuracyScore;

  // Use accuracyIssues as the verification description when available
  const verificationText = quote.accuracyIssues || (
    verdict === "accurate" ? "Supported by source" :
    quote.quoteVerified ? "Quote verified" :
    null
  );

  return (
    <div className="flex gap-3 py-1.5 border-b border-border/40 last:border-b-0">
      {/* Claim from the wiki page */}
      <div className="flex-1 min-w-0 text-[11px] text-foreground leading-snug">
        {renderInlineMarkdown(quote.claimText)}
      </div>
      {/* Verification result */}
      <div className="flex-1 min-w-0 text-[11px] leading-snug">
        {Icon && label && (
          <span className={cn("inline-flex items-center gap-0.5 px-1 py-px rounded", color, bg)}>
            <Icon className="w-3 h-3 shrink-0" />
            {label}
            {score != null && (
              <span className="opacity-60 ml-0.5">{Math.round(score * 100)}%</span>
            )}
          </span>
        )}
        {verificationText && (
          <p className="text-muted-foreground m-0 mt-0.5">
            {verificationText}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Client component that reads citation quote data from context and renders
 * verification details for a specific resource URL in the expanded reference.
 *
 * Two-column layout: claim text (left) | verification verdict + issues (right).
 */
export function ReferenceCitationDetails({ url }: { url: string }) {
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
    <div className="mt-1.5 pt-1.5 border-t border-border pl-2">
      <div>
        <div className="flex gap-3 text-[10px] text-muted-foreground/50 uppercase tracking-wide pb-0.5 border-b border-border/40">
          <div className="flex-1">Claim</div>
          <div className="flex-1">Verification</div>
        </div>
        {shown.map((q, i) => (
          <ClaimRow key={i} quote={q} />
        ))}
      </div>
      {remaining > 0 && (
        <span className="text-[11px] text-muted-foreground/60 block mt-0.5">
          +{remaining} more
        </span>
      )}
    </div>
  );
}
