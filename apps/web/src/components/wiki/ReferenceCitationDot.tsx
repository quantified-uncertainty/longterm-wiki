"use client";

import { cn } from "@lib/utils";
import { useCitationQuotes } from "./CitationQuotesContext";

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return (
      u.host.replace(/^www\./, "") +
      u.pathname.replace(/\/+$/, "") +
      u.search
    ).toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

const VERDICT_COLORS: Record<string, { bg: string; title: string }> = {
  accurate: { bg: "bg-emerald-500", title: "Verified accurate" },
  minor_issues: { bg: "bg-amber-500", title: "Minor issues" },
  inaccurate: { bg: "bg-red-500", title: "Inaccurate" },
  unsupported: { bg: "bg-red-400", title: "Unsupported" },
  not_verifiable: { bg: "bg-muted-foreground/40", title: "Not verifiable" },
};

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

  if (!info && !best.quoteVerified) return null;

  const bg = info?.bg ?? "bg-blue-500";
  const title = info?.title ?? "Source verified";

  return (
    <span
      className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", bg)}
      title={title}
    />
  );
}
