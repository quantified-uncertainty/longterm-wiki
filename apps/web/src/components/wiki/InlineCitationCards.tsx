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
import { getDomain } from "./resource-utils";

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

const VERIFIED_ONLY_CONFIG: VerdictConfig = {
  icon: CheckCircle2,
  label: "Source verified",
  color: "text-blue-700 dark:text-blue-400",
  iconColor: "text-blue-500",
  dotColor: "bg-blue-500",
};

/** Check if accuracy-issues text just restates the verdict (e.g. "Unsupported" when badge already says that) */
function isRedundantWithVerdict(issuesText: string, verdictLabel: string): boolean {
  const normalized = issuesText.trim().toLowerCase();
  const verdictLower = verdictLabel.trim().toLowerCase();
  return normalized === verdictLower || normalized.startsWith(verdictLower + ":") || normalized.startsWith(verdictLower + ".");
}

function getVerdictConfig(quote: CitationQuote): VerdictConfig | null {
  if (quote.accuracyVerdict) {
    return VERDICT_CONFIG[quote.accuracyVerdict] ?? null;
  }
  if (quote.quoteVerified) {
    return VERIFIED_ONLY_CONFIG;
  }
  return null;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

/** Render a hover card for a footnote ref with verification metadata */
function FootnoteCard({
  quote,
  anchor,
}: {
  quote: CitationQuote;
  anchor: HTMLElement;
}) {
  const config = getVerdictConfig(quote);
  if (!config) return null;

  const Icon = config.icon;
  const checkedAt = quote.accuracyCheckedAt || quote.verifiedAt;

  const sourceTitle = quote.sourceTitle;
  const sourceDomain = quote.url ? getDomain(quote.url) : null;
  const resourceId = quote.resourceId;

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
          {/* Verdict header */}
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

          {/* Source title + domain */}
          {sourceTitle && (
            <p className="text-xs font-medium text-foreground mb-1 line-clamp-2">
              {sourceTitle}
            </p>
          )}
          {sourceDomain && (
            <p className="text-[11px] text-muted-foreground mb-1.5">
              {sourceDomain}
            </p>
          )}

          {/* Supporting quote */}
          {quote.sourceQuote && (
            <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 my-2 line-clamp-4 italic">
              &ldquo;{quote.sourceQuote}&rdquo;
            </blockquote>
          )}

          {/* Issues — skip when text just restates the verdict label */}
          {quote.accuracyIssues && !isRedundantWithVerdict(quote.accuracyIssues, config.label) && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 line-clamp-3">
              {quote.accuracyIssues}
            </p>
          )}

          {/* Footer */}
          <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50">
            {checkedAt && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Checked {formatDate(checkedAt)}
              </span>
            )}
            {quote.url && isSafeUrl(quote.url) && (
              <a
                href={quote.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5 ml-auto"
              >
                Source <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
            {/* Link to unified references section */}
            <a
              href="#references"
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 ml-auto !no-underline"
            >
              View in References
            </a>
          </div>
          {resourceId && (
            <div className="mt-1.5">
              <a
                href={`/source/${resourceId}`}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline !no-underline hover:!underline"
              >
                View source details
              </a>
            </div>
          )}

          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>,
    anchor
  );
}

interface InlineCitationCardsProps {
  quotes: CitationQuote[];
}

/**
 * InlineCitationCards — renders verification indicators on footnote references.
 *
 * Uses DOM queries after hydration to find footnote ref links
 * (generated by remark-gfm) and attaches HoverCard popovers.
 */
export function InlineCitationCards({
  quotes,
}: InlineCitationCardsProps) {
  const [refAnchors, setRefAnchors] = useState<
    Array<{ wrapper: HTMLElement; quote: CitationQuote; footnoteNum: number }>
  >([]);

  useEffect(() => {
    const article = document.querySelector("article.prose");
    if (!article) return;

    const quoteMap = new Map(quotes.map((q) => [q.footnote, q]));
    const anchors: Array<{
      wrapper: HTMLElement;
      quote: CitationQuote;
      footnoteNum: number;
    }> = [];
    const createdElements: HTMLElement[] = [];

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

      let wrapper = ref.nextElementSibling as HTMLElement | null;
      if (!wrapper || !wrapper.classList.contains("citation-overlay-anchor")) {
        wrapper = document.createElement("span");
        wrapper.className = "citation-overlay-anchor";
        wrapper.style.position = "relative";
        wrapper.style.display = "inline";
        ref.parentNode?.insertBefore(wrapper, ref.nextSibling);
        createdElements.push(wrapper);
      }

      anchors.push({ wrapper, quote, footnoteNum: num });
    }

    setRefAnchors(anchors);

    return () => {
      for (const el of createdElements) {
        el.remove();
      }
      setRefAnchors([]);
    };
  }, [quotes]);

  if (quotes.length === 0) return null;

  return (
    <>
      {refAnchors.map(({ wrapper, quote }) => (
        <FootnoteCard
          key={`fn-${quote.footnote}`}
          quote={quote}
          anchor={wrapper}
        />
      ))}
    </>
  );
}
