"use client";

import { cn } from "@lib/utils";
import { useCitationQuotes } from "./CitationQuotesContext";
import { normalizeUrl, VERDICT_COLORS } from "./resource-utils";

export function ReferenceCitationDot({ url }: { url: string }) {
  const quotes = useCitationQuotes();
  if (quotes.length === 0) return null;

  const norm = normalizeUrl(url);
  const matching = quotes.filter(
    (q) => q.url && normalizeUrl(q.url) === norm
  );
  if (matching.length === 0) return null;

  // Pick the most informative quote
  const best = matching.sort((a, b) => {
    const scoreA = (a.accuracyVerdict ? 2 : 0) + (a.sourceQuote ? 1 : 0);
    const scoreB = (b.accuracyVerdict ? 2 : 0) + (b.sourceQuote ? 1 : 0);
    return scoreB - scoreA;
  })[0];

  const verdict = best.accuracyVerdict;
  const info = verdict ? VERDICT_COLORS[verdict] : null;

  // Show all statement-backed citations: verified (blue), verdict-colored, or neutral (unverified)
  const bg = info?.bg ?? (best.quoteVerified ? "bg-blue-500" : "bg-muted-foreground/40");
  const title = info?.title ?? (best.quoteVerified ? "Source verified" : "Citation present (unverified)");

  return (
    <span
      className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0 ml-1.5 align-middle", bg)}
      title={title}
    />
  );
}
