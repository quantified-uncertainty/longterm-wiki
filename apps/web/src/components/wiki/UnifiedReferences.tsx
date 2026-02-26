import React from "react";
import Link from "next/link";
import {
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getFootnoteIndex,
} from "@data";
import type { Resource, FootnoteSourceEntry } from "@data";
import { CredibilityBadge } from "./CredibilityBadge";
import { ReferenceCitationDetails } from "./ReferenceCitationDetails";
import { ReferenceCitationDot } from "./ReferenceCitationDot";
import { formatAuthors, getDomain } from "./resource-utils";
import { cn } from "@lib/utils";

const TYPE_LABELS: Record<string, string> = {
  paper: "Paper",
  book: "Book",
  blog: "Blog post",
  report: "Report",
  talk: "Talk",
  podcast: "Podcast",
  government: "Government",
  reference: "Reference",
  web: "Web",
};

interface UnifiedRefEntry {
  /** Display index (1-based) in the unified bibliography */
  index: number;
  /** Source URL */
  url: string | null;
  /** Display title */
  title: string;
  /** All footnote numbers that reference this source */
  footnoteNumbers: number[];
  /** Resolved resource, if any */
  resource: Resource | null;
  /** Credibility score from resource/publication */
  credibility: number | undefined;
  /** Publication name from resource */
  publicationName: string | undefined;
  /** Peer-reviewed status */
  peerReviewed: boolean;
  /** Raw footnote text for sources without a URL */
  rawText: string | null;
}

function resolveEntries(
  pageId: string
): { entries: UnifiedRefEntry[]; hasFootnotes: boolean } {
  const fnIndex = getFootnoteIndex(pageId);
  if (!fnIndex) return { entries: [], hasFootnotes: false };

  const entries: UnifiedRefEntry[] = [];
  let index = 1;

  // First: entries from deduplicated source groups (have URLs)
  for (const source of fnIndex.sources) {
    const resource = source.resourceId
      ? (getResourceById(source.resourceId) ?? null)
      : null;

    const publication = resource
      ? getResourcePublication(resource)
      : undefined;

    entries.push({
      index: index++,
      url: source.url,
      title: resource?.title || source.title,
      footnoteNumbers: source.footnoteNumbers,
      resource,
      credibility: resource ? getResourceCredibility(resource) : undefined,
      publicationName: publication?.name,
      peerReviewed: publication?.peer_reviewed ?? false,
      rawText: null,
    });
  }

  // Second: footnotes without URLs (academic-style citations)
  const sourceFootnoteNumbers = new Set(
    fnIndex.sources.flatMap((s) => s.footnoteNumbers)
  );
  for (const [numStr, fn] of Object.entries(fnIndex.footnotes)) {
    const num = parseInt(numStr, 10);
    if (sourceFootnoteNumbers.has(num)) continue;
    if (fn.url) continue; // shouldn't happen, but be safe

    entries.push({
      index: index++,
      url: null,
      title: fn.title || `[${num}]`,
      footnoteNumbers: [num],
      resource: null,
      credibility: undefined,
      publicationName: undefined,
      peerReviewed: false,
      rawText: fn.title,
    });
  }

  return { entries, hasFootnotes: Object.keys(fnIndex.footnotes).length > 0 };
}

function BackRefs({ numbers }: { numbers: number[] }) {
  if (numbers.length <= 1) return null;
  return (
    <span className="text-[10px] text-muted-foreground/50 ml-2">
      {numbers.map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && " "}
          <a
            href={`#user-content-fnref-${n}`}
            className="hover:text-foreground transition-colors !no-underline"
          >
            [{n}]
          </a>
        </React.Fragment>
      ))}
    </span>
  );
}

/** Compact dot showing whether resource content has been fetched */
function FetchStatusDot({ resource }: { resource: Resource | null }) {
  if (!resource) return null;
  if (resource.local_filename) {
    return (
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1 align-middle"
        title={`Full text fetched${resource.fetched_at ? ` on ${resource.fetched_at.slice(0, 10)}` : ""}`}
      />
    );
  }
  if (resource.fetched_at) {
    return (
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ml-1 align-middle"
        title={`Metadata only — fetched ${resource.fetched_at.slice(0, 10)}`}
      />
    );
  }
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-red-400/50 ml-1 align-middle"
      title="Not fetched"
    />
  );
}

function UnifiedRefRow({ entry }: { entry: UnifiedRefEntry }) {
  const { resource, index, credibility, publicationName, peerReviewed, url, title, footnoteNumbers, rawText } = entry;
  const year = resource?.published_date?.slice(0, 4);
  const authorStr = resource?.authors ? formatAuthors(resource.authors) : null;
  const typeLabel = resource?.type ? TYPE_LABELS[resource.type] : null;
  const domain = url ? getDomain(url) : null;

  // Metadata fragments: source · author · year · type
  const metaParts: React.ReactNode[] = [];
  if (publicationName) {
    metaParts.push(
      <span key="pub" className="italic">
        {publicationName}
        {peerReviewed && " (peer-reviewed)"}
      </span>
    );
  } else if (domain && resource) {
    metaParts.push(<span key="domain">{domain}</span>);
  }
  if (authorStr) {
    metaParts.push(<span key="author">{authorStr}</span>);
  }
  if (year) {
    metaParts.push(<span key="year">{year}</span>);
  }
  if (typeLabel) {
    metaParts.push(<span key="type">{typeLabel}</span>);
  }

  // For academic citations without URLs, show the raw text
  if (!url && rawText) {
    return (
      <div className="py-1 border-b border-border last:border-b-0">
        {/* Anchor for footnote back-links */}
        {footnoteNumbers.map((n) => (
          <React.Fragment key={n}>
            <span id={`user-content-fn-${n}`} className="scroll-mt-4" />
            <span id={`fn-${n}`} />
          </React.Fragment>
        ))}
        <div className="-mx-1.5 px-1.5 py-0.5">
          <div className="flex items-baseline">
            <span className="shrink-0 w-7 text-xs font-mono text-muted-foreground/60 tabular-nums text-right pr-2">
              {index}
            </span>
            <span className="flex-1 min-w-0 text-[13px] text-muted-foreground leading-tight">
              {rawText}
              <BackRefs numbers={footnoteNumbers} />
            </span>
          </div>
        </div>
      </div>
    );
  }

  const hasExpandableContent = !!resource?.summary || credibility != null || !!url;

  const titleRow = (
    <div className="flex items-baseline">
      {/* Number gutter */}
      <span className="shrink-0 w-7 text-xs font-mono text-muted-foreground/60 tabular-nums text-right pr-2">
        {index}
      </span>
      {/* Title + metadata */}
      <span className="flex-1 min-w-0">
        {resource?.id ? (
          <a
            href={`/source/${resource.id}`}
            className="text-[13px] text-accent-foreground !no-underline hover:!underline leading-tight"
          >
            {title}
          </a>
        ) : url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-accent-foreground !no-underline hover:!underline leading-tight"
          >
            {title}
          </a>
        ) : (
          <span className="text-[13px] text-accent-foreground leading-tight">
            {title}
          </span>
        )}
        <FetchStatusDot resource={resource} />
        {url && <ReferenceCitationDot url={url} />}
        {metaParts.length > 0 && (
          <span className="text-xs text-muted-foreground ml-1.5">
            {metaParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="opacity-30 mx-1">{"\u00b7"}</span>}
                {part}
              </React.Fragment>
            ))}
          </span>
        )}
        <BackRefs numbers={footnoteNumbers} />
      </span>
      {hasExpandableContent && (
        <span className="ref-chevron shrink-0 ml-2 text-muted-foreground/30 text-[10px] transition-transform duration-150 group-hover:text-muted-foreground/60">
          {"\u25c0"}
        </span>
      )}
    </div>
  );

  // Anchor elements for all footnotes pointing to this source
  const anchors = footnoteNumbers.map((n) => (
    <React.Fragment key={n}>
      <span id={`user-content-fn-${n}`} className="scroll-mt-4" />
      <span id={`fn-${n}`} />
    </React.Fragment>
  ));

  if (!hasExpandableContent) {
    return (
      <div className="py-1 border-b border-border last:border-b-0">
        {anchors}
        <div className="-mx-1.5 px-1.5 py-0.5">{titleRow}</div>
      </div>
    );
  }

  return (
    <div className="py-1 border-b border-border last:border-b-0">
      {anchors}
      <details className="ref-details group">
        <summary className="ref-summary cursor-pointer select-none hover:bg-muted/50 -mx-1.5 px-1.5 py-0.5 rounded transition-colors">
          {titleRow}
        </summary>
        <div className="mt-1 mb-0.5 overflow-hidden">
          {resource?.summary && (
            <p className="text-xs text-muted-foreground leading-relaxed m-0">
              {resource.summary}
            </p>
          )}
          {credibility != null && (
            <div className="mt-1.5">
              <CredibilityBadge level={credibility} size="sm" />
            </div>
          )}
          {url && <ReferenceCitationDetails url={url} />}
        </div>
      </details>
    </div>
  );
}

interface UnifiedReferencesProps {
  pageId: string;
  className?: string;
}

/**
 * <UnifiedReferences> — Unified bibliography section that merges
 * footnote data, resource metadata, and verification indicators
 * into a single deduplicated reference list.
 *
 * Replaces the dual remark-gfm-footnotes + References component layout.
 * Groups footnotes by unique source URL, shows rich metadata for matched
 * resources, and falls back to raw text for academic-style citations.
 */
export function UnifiedReferences({ pageId, className }: UnifiedReferencesProps) {
  const { entries, hasFootnotes } = resolveEntries(pageId);

  // Nothing to show
  if (entries.length === 0 && !hasFootnotes) return null;

  const withResources = entries.filter((e) => e.resource);
  const totalSources = entries.length;

  return (
    <section
      className={cn("mt-10 pt-5 border-t border-border", className)}
      aria-label="References"
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mt-0 pb-0 border-b-0"
          id="references"
        >
          References
          <span className="text-xs font-normal ml-2 opacity-60">
            {totalSources} source{totalSources !== 1 ? "s" : ""}
            {withResources.length > 0 &&
              withResources.length < totalSources &&
              ` \u00b7 ${withResources.length} with metadata`}
          </span>
        </h2>
        <Link
          href={`/claims/entity/${pageId}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View claims →
        </Link>
      </div>

      {entries.length > 0 && (
        <div>
          {entries.map((entry, i) => (
            <UnifiedRefRow key={`ref-${i}`} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}
