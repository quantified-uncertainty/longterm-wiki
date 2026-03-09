"use client";

import React from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { ExternalLink, Clock } from "lucide-react";
import { cn } from "@lib/utils";
import { isSafeUrl } from "@lib/url-utils";
import { SafeExternalLink } from "@components/ui/safe-external-link";
import { useReferenceData } from "./ReferenceContext";
import { VerdictBadge } from "./VerdictBadge";
import { getDomain } from "./resource-utils";
import type { RefMapEntry } from "./ReferenceContext";

/**
 * Format an ISO date string for compact display.
 */
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

/** Check if accuracy-issues text just restates the verdict label */
function isRedundantWithVerdict(
  issuesText: string,
  verdictLabel: string
): boolean {
  const normalized = issuesText.trim().toLowerCase();
  const verdictLower = verdictLabel.trim().toLowerCase();
  return (
    normalized === verdictLower ||
    normalized.startsWith(verdictLower + ":") ||
    normalized.startsWith(verdictLower + ".")
  );
}

/**
 * Content displayed for a claim-type reference.
 * Shows verdict badge, source title, source quote, and accuracy issues.
 */
function ClaimContent({ entry }: { entry: RefMapEntry }) {
  const checkedAt = entry.checkedAt;
  const sourceUrl = entry.sourceUrl;
  const domain = sourceUrl ? getDomain(sourceUrl) : null;

  // Determine a label for redundancy check
  const verdictLabels: Record<string, string> = {
    accurate: "Verified",
    minor_issues: "Minor Issues",
    inaccurate: "Disputed",
    unsupported: "Unsupported",
    not_verifiable: "Unverified",
  };
  const verdictLabel = entry.verdict
    ? verdictLabels[entry.verdict] ?? entry.verdict
    : "";

  return (
    <>
      {/* Verdict badge */}
      <div className="mb-2">
        <VerdictBadge
          verdict={entry.verdict}
          quoteVerified={entry.quoteVerified}
          score={entry.verdictScore}
          size="md"
        />
      </div>

      {/* Source title + domain */}
      {entry.sourceTitle && (
        <p className="text-xs font-medium text-foreground mb-0.5 line-clamp-2 m-0">
          {entry.sourceTitle}
        </p>
      )}
      {domain && (
        <p className="text-[11px] text-muted-foreground mb-1.5 m-0">
          {domain}
        </p>
      )}

      {/* Source quote */}
      {entry.sourceQuote && (
        <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 my-2 line-clamp-4 italic">
          &ldquo;{entry.sourceQuote}&rdquo;
        </blockquote>
      )}

      {/* Accuracy issues -- skip when redundant with verdict label */}
      {entry.accuracyIssues &&
        !isRedundantWithVerdict(entry.accuracyIssues, verdictLabel) && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 line-clamp-3 m-0">
            {entry.accuracyIssues}
          </p>
        )}

      {/* Footer: checked date + source link */}
      <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50">
        {checkedAt && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Checked {formatDate(checkedAt)}
          </span>
        )}
        <span className="flex-1" />
        <SafeExternalLink
          href={sourceUrl}
          className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5 !no-underline hover:!underline"
        >
          Source <ExternalLink className="w-2.5 h-2.5" />
        </SafeExternalLink>
      </div>

      {/* Link to source detail page if resource is known */}
      {entry.resourceId && (
        <div className="mt-1.5">
          <a
            href={`/source/${entry.resourceId}`}
            className="text-xs text-blue-600 dark:text-blue-400 !no-underline hover:!underline"
          >
            View source details
          </a>
        </div>
      )}
    </>
  );
}

/**
 * Content displayed for a regular citation (no claim verification data).
 * Shows title, domain, and note if available.
 */
function CitationContent({ entry }: { entry: RefMapEntry }) {
  const url = entry.url;
  const domain = entry.domain || (url ? getDomain(url) : null);

  return (
    <>
      {/* Title */}
      {entry.title && (
        <p className="text-xs font-medium text-foreground mb-1 line-clamp-2 m-0">
          {entry.title}
        </p>
      )}

      {/* Domain */}
      {domain && (
        <p className="text-[11px] text-muted-foreground mb-1 m-0">{domain}</p>
      )}

      {/* Note */}
      {entry.note && (
        <p className="text-xs text-muted-foreground/80 m-0 mt-1 line-clamp-3">
          {entry.note}
        </p>
      )}

      {/* Source link */}
      {url && isSafeUrl(url) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/50">
          <SafeExternalLink
            href={url}
            className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5 !no-underline hover:!underline"
          >
            Open source <ExternalLink className="w-2.5 h-2.5" />
          </SafeExternalLink>
          <span className="flex-1" />
          <a
            href="#references"
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 !no-underline"
          >
            View in References
          </a>
        </div>
      )}
    </>
  );
}

/**
 * Content displayed for a KB fact reference.
 * Shows property name, value, date, source link -- mirrors the KBF tooltip.
 */
function KBFactContent({ entry }: { entry: RefMapEntry }) {
  const sourceUrl = entry.kbSource;
  const domain = sourceUrl ? getDomain(sourceUrl) : null;

  return (
    <>
      {/* Property label */}
      {entry.kbProperty && (
        <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
          {entry.kbProperty}
        </span>
      )}

      {/* Value */}
      {entry.kbValue && (
        <span className="block font-semibold text-foreground text-sm mb-1">
          {entry.kbValue}
        </span>
      )}

      {/* As-of date */}
      {entry.kbAsOf && (
        <span className="block text-xs text-muted-foreground">
          As of: {entry.kbAsOf}
        </span>
      )}

      {/* Notes */}
      {entry.kbNotes && (
        <p className="text-xs text-muted-foreground/80 m-0 mt-1 line-clamp-3">
          {entry.kbNotes}
        </p>
      )}

      {/* Source link */}
      {sourceUrl && isSafeUrl(sourceUrl) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/50">
          <SafeExternalLink
            href={sourceUrl}
            className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5 !no-underline hover:!underline"
          >
            Source{domain ? ` (${domain})` : ""} <ExternalLink className="w-2.5 h-2.5" />
          </SafeExternalLink>
        </div>
      )}

      {/* entity.property key */}
      {entry.kbEntity && (
        <span className="block text-muted-foreground/60 mt-1.5 font-mono text-[10px]">
          {entry.kbEntity}.{entry.kbProperty}
        </span>
      )}
    </>
  );
}

interface FootnoteTooltipProps {
  /** The footnote number (1-based) */
  footnoteNumber: number;
  /** The original footnote element to wrap */
  children: React.ReactNode;
}

/**
 * FootnoteTooltip -- a hover card that appears when hovering over a
 * footnote superscript in wiki articles.
 *
 * Shows different content depending on the reference type:
 * - Claim references: verdict badge, source title, source quote, accuracy info
 * - Regular citations: title, domain, optional note
 *
 * Uses @radix-ui/react-hover-card for hover (desktop) / tap (mobile) behavior,
 * matching the pattern established by CitationOverlay and InlineCitationCards.
 *
 * Data is consumed from ReferenceContext. If no reference data is available
 * for the given footnote number, the tooltip renders children without a wrapper.
 */
export function FootnoteTooltip({
  footnoteNumber,
  children,
}: FootnoteTooltipProps) {
  const refData = useReferenceData(footnoteNumber);

  // No reference data available -- render children as-is
  if (!refData) {
    return <>{children}</>;
  }

  return (
    <HoverCard.Root openDelay={200} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <span className="footnote-tooltip-trigger">{children}</span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className={cn(
            "z-50 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg",
            "animate-in fade-in-0 zoom-in-95",
            "data-[side=bottom]:slide-in-from-top-2",
            "data-[side=top]:slide-in-from-bottom-2"
          )}
          side="bottom"
          align="start"
          sideOffset={6}
        >
          {refData.type === "claim" ? (
            <ClaimContent entry={refData} />
          ) : refData.type === "kb" ? (
            <KBFactContent entry={refData} />
          ) : (
            <CitationContent entry={refData} />
          )}
          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
