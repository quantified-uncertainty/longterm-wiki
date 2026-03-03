"use client";

import { useState } from "react";
import { ExternalLink, ChevronDown, ChevronUp, Star } from "lucide-react";

interface Citation {
  id: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  locationNote: string | null;
  isPrimary: boolean;
}

function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Expandable citation detail panel. Clicking the citation count badge
 * toggles a list of citations with URLs, source quotes, and resource links.
 */
export function CitationDetail({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);

  if (citations.length === 0) {
    return <span className="text-muted-foreground">0</span>;
  }

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 text-[11px] font-medium hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors cursor-pointer"
        aria-expanded={open}
        aria-label={`${citations.length} citation${citations.length !== 1 ? "s" : ""}`}
      >
        {citations.length}
        {open ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg border border-border bg-popover p-2 shadow-lg text-left">
          <div className="space-y-2">
            {citations.map((cit) => (
              <CitationItem key={cit.id} citation={cit} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CitationItem({ citation: cit }: { citation: Citation }) {
  const domain = cit.url ? getDomain(cit.url) : null;

  return (
    <div className="rounded border border-border/40 p-2 text-xs">
      {/* Header: URL + primary badge */}
      <div className="flex items-center gap-1.5 mb-1">
        {cit.isPrimary && (
          <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
            <Star className="w-3 h-3 fill-current" />
            <span className="text-[10px] font-medium">Primary</span>
          </span>
        )}
        {cit.url && isSafeUrl(cit.url) && (
          <a
            href={cit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-600 hover:underline truncate ml-auto"
          >
            <span className="truncate">{domain ?? cit.url}</span>
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        )}
      </div>

      {/* Source quote */}
      {cit.sourceQuote && (
        <blockquote className="text-muted-foreground border-l-2 border-border pl-2 my-1 line-clamp-3 italic">
          &ldquo;{cit.sourceQuote}&rdquo;
        </blockquote>
      )}

      {/* Location note */}
      {cit.locationNote && (
        <p className="text-muted-foreground/70 text-[10px] mt-1">
          {cit.locationNote}
        </p>
      )}

      {/* Resource link */}
      {cit.resourceId && (
        <a
          href={`/source/${cit.resourceId}`}
          className="text-[10px] text-blue-600 hover:underline mt-1 inline-block"
        >
          View source details
        </a>
      )}
    </div>
  );
}

/**
 * Inline citation badges for attributed statement cards.
 * Shows citation count and expands to reveal details on click.
 */
export function AttributedCitationDetail({
  citations,
}: {
  citations: Citation[];
}) {
  const [open, setOpen] = useState(false);

  if (citations.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 text-[11px] font-medium hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors cursor-pointer"
        aria-expanded={open}
        aria-label={`${citations.length} citation${citations.length !== 1 ? "s" : ""}`}
      >
        {citations.length} cite{citations.length !== 1 ? "s" : ""}
        {open ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg border border-border bg-popover p-2 shadow-lg">
          <div className="space-y-2">
            {citations.map((cit) => (
              <CitationItem key={cit.id} citation={cit} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
