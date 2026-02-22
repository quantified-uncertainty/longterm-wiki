"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as HoverCard from "@radix-ui/react-hover-card";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  ExternalLink,
} from "lucide-react";
import type { CitationQuote } from "@/lib/citation-data";

interface VerdictConfig {
  icon: typeof CheckCircle2;
  label: string;
  color: string;
  iconColor: string;
  dotColor: string;
}

const VERDICT_CONFIG: Record<string, VerdictConfig> = {
  accurate: {
    icon: CheckCircle2,
    label: "Verified accurate",
    color: "text-emerald-700 dark:text-emerald-400",
    iconColor: "text-emerald-500",
    dotColor: "bg-emerald-500",
  },
  minor_issues: {
    icon: AlertTriangle,
    label: "Minor issues",
    color: "text-amber-700 dark:text-amber-400",
    iconColor: "text-amber-500",
    dotColor: "bg-amber-500",
  },
  inaccurate: {
    icon: XCircle,
    label: "Inaccurate",
    color: "text-red-700 dark:text-red-400",
    iconColor: "text-red-500",
    dotColor: "bg-red-500",
  },
  unsupported: {
    icon: XCircle,
    label: "Unsupported",
    color: "text-red-600 dark:text-red-400",
    iconColor: "text-red-400",
    dotColor: "bg-red-400",
  },
  not_verifiable: {
    icon: HelpCircle,
    label: "Not verifiable",
    color: "text-muted-foreground",
    iconColor: "text-muted-foreground",
    dotColor: "bg-muted-foreground",
  },
};

/** Default config for citations that have been quote-verified but not accuracy-checked */
const VERIFIED_ONLY_CONFIG: VerdictConfig = {
  icon: CheckCircle2,
  label: "Source verified",
  color: "text-blue-700 dark:text-blue-400",
  iconColor: "text-blue-500",
  dotColor: "bg-blue-500",
};

function getVerdictConfig(quote: CitationQuote): VerdictConfig | null {
  if (quote.accuracyVerdict) {
    return VERDICT_CONFIG[quote.accuracyVerdict] ?? null;
  }
  if (quote.quoteVerified) {
    return VERIFIED_ONLY_CONFIG;
  }
  return null;
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

/** A single footnote indicator rendered via portal next to the footnote ref link */
function FootnoteIndicator({ quote, anchor }: { quote: CitationQuote; anchor: HTMLElement }) {
  const config = getVerdictConfig(quote);
  if (!config) return null;

  const Icon = config.icon;
  const checkedAt = quote.accuracyCheckedAt || quote.verifiedAt;

  return createPortal(
    <HoverCard.Root openDelay={200} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <span
          className="citation-verification-dot"
          data-verdict={quote.accuracyVerdict || "verified"}
          aria-label={config.label}
        >
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${config.dotColor}`} />
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="z-50 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
          side="bottom"
          align="start"
          sideOffset={6}
        >
          {/* Header: verdict + icon */}
          <div className="flex items-center gap-2 mb-2">
            <Icon className={`w-4 h-4 ${config.iconColor} shrink-0`} />
            <span className={`text-sm font-semibold ${config.color}`}>
              {config.label}
            </span>
            {quote.accuracyScore !== null && (
              <span className="text-xs text-muted-foreground ml-auto tabular-nums">
                {Math.round(quote.accuracyScore * 100)}% confidence
              </span>
            )}
          </div>

          {/* Source title */}
          {quote.sourceTitle && (
            <p className="text-xs font-medium text-foreground mb-1.5 line-clamp-2">
              {quote.sourceTitle}
            </p>
          )}

          {/* Supporting quote from source */}
          {quote.sourceQuote && (
            <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 my-2 line-clamp-4 italic">
              &ldquo;{quote.sourceQuote}&rdquo;
            </blockquote>
          )}

          {/* Issues */}
          {quote.accuracyIssues && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
              {quote.accuracyIssues}
            </p>
          )}

          {/* Footer: date + link */}
          <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50">
            {checkedAt && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Checked {formatDate(checkedAt)}
              </span>
            )}
            {quote.url && (
              <a
                href={quote.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5 ml-auto"
              >
                Source <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>

          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>,
    anchor
  );
}

/** Verification details block rendered inside a footnote list item */
function FootnoteVerificationDetail({ quote }: { quote: CitationQuote }) {
  const config = getVerdictConfig(quote);
  if (!config) return null;

  const Icon = config.icon;
  const checkedAt = quote.accuracyCheckedAt || quote.verifiedAt;

  return (
    <div className="citation-fn-detail">
      {/* Verdict header */}
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className={`w-3 h-3 ${config.iconColor} shrink-0`} />
        <span className={`text-[11px] font-semibold ${config.color}`}>
          {config.label}
        </span>
        {quote.accuracyScore !== null && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            ({Math.round(quote.accuracyScore * 100)}%)
          </span>
        )}
        {checkedAt && (
          <span className="text-[10px] text-muted-foreground ml-auto flex items-center gap-0.5">
            <Clock className="w-2.5 h-2.5" />
            {formatDate(checkedAt)}
          </span>
        )}
      </div>

      {/* Source title */}
      {quote.sourceTitle && (
        <p className="text-[11px] font-medium text-muted-foreground mb-1 line-clamp-1">
          {quote.sourceTitle}
        </p>
      )}

      {/* Supporting quote */}
      {quote.sourceQuote && (
        <blockquote className="text-[11px] text-muted-foreground/80 border-l-2 border-border pl-2 my-1 line-clamp-3 italic leading-snug">
          &ldquo;{quote.sourceQuote}&rdquo;
        </blockquote>
      )}

      {/* Issues */}
      {quote.accuracyIssues && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 leading-snug">
          {quote.accuracyIssues}
        </p>
      )}
    </div>
  );
}

/** Enriches the footnote section at the bottom with verification details */
function FootnoteSectionEnricher({
  quotes,
  containerRef,
}: {
  quotes: CitationQuote[];
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [footnoteItems, setFootnoteItems] = useState<
    Array<{ element: HTMLElement; quote: CitationQuote }>
  >([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items: Array<{ element: HTMLElement; quote: CitationQuote }> = [];
    const quoteMap = new Map(quotes.map((q) => [q.footnote, q]));

    // Find all footnote list items: <li id="user-content-fn-N">
    const lis = container.querySelectorAll<HTMLElement>(
      "section[data-footnotes] li[id]"
    );
    for (const li of lis) {
      const id = li.id;
      const match = id.match(/user-content-fn-(\d+)/);
      if (!match) continue;
      const num = parseInt(match[1], 10);
      const quote = quoteMap.get(num);
      if (quote && getVerdictConfig(quote)) {
        // Create a dedicated container div for the verification detail if not already present
        let detailContainer = li.querySelector(".citation-fn-detail-container") as HTMLElement | null;
        if (!detailContainer) {
          detailContainer = document.createElement("div");
          detailContainer.className = "citation-fn-detail-container";
          li.appendChild(detailContainer);
        }
        items.push({ element: detailContainer, quote });
      }
    }
    setFootnoteItems(items);
  }, [quotes, containerRef]);

  return (
    <>
      {footnoteItems.map(({ element, quote }) => {
        return createPortal(
          <FootnoteVerificationDetail key={`fn-detail-${quote.footnote}`} quote={quote} />,
          element
        );
      })}
    </>
  );
}

/**
 * CitationOverlay — renders verification indicators on footnote references.
 *
 * This component uses DOM queries after hydration to find footnote ref links
 * (generated by remark-gfm) and attaches HoverCard popovers with verification
 * details from the wiki-server citation_quotes table.
 *
 * The approach uses React portals to inject into the remark-gfm-generated DOM
 * without modifying the MDX compilation pipeline.
 */
export function CitationOverlay({ quotes }: { quotes: CitationQuote[] }) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [refAnchors, setRefAnchors] = useState<
    Array<{ wrapper: HTMLElement; quote: CitationQuote }>
  >([]);

  useEffect(() => {
    // Find the prose article element containing the rendered MDX
    const article = document.querySelector("article.prose");
    if (!article) return;
    containerRef.current = article as HTMLElement;

    const quoteMap = new Map(quotes.map((q) => [q.footnote, q]));
    const anchors: Array<{ wrapper: HTMLElement; quote: CitationQuote }> = [];

    // Find all inline footnote refs: <a data-footnote-ref href="#user-content-fn-N">
    const refs = article.querySelectorAll<HTMLAnchorElement>(
      "a[data-footnote-ref]"
    );

    for (const ref of refs) {
      const href = ref.getAttribute("href") || "";
      const match = href.match(/user-content-fn-(\d+)/);
      if (!match) continue;

      const num = parseInt(match[1], 10);
      const quote = quoteMap.get(num);
      if (!quote || !getVerdictConfig(quote)) continue;

      // Create a wrapper span next to the footnote ref for the portal target
      let wrapper = ref.nextElementSibling as HTMLElement | null;
      if (!wrapper || !wrapper.classList.contains("citation-overlay-anchor")) {
        wrapper = document.createElement("span");
        wrapper.className = "citation-overlay-anchor";
        wrapper.style.position = "relative";
        wrapper.style.display = "inline";
        ref.parentNode?.insertBefore(wrapper, ref.nextSibling);
      }

      anchors.push({ wrapper, quote });
    }

    setRefAnchors(anchors);
  }, [quotes]);

  if (quotes.length === 0) return null;

  return (
    <>
      {refAnchors.map(({ wrapper, quote }) => (
        <FootnoteIndicator
          key={`fn-${quote.footnote}`}
          quote={quote}
          anchor={wrapper}
        />
      ))}
      <FootnoteSectionEnricher quotes={quotes} containerRef={containerRef} />
    </>
  );
}

