import React from "react";
import {
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPageCitationHealth,
} from "@data";
import type { Resource } from "@data";
import { CredibilityBadge } from "./CredibilityBadge";
import { ResourceTags } from "./ResourceTags";
import { ReferenceCitationDetails } from "./ReferenceCitationDetails";
import { ReferenceCitationDot } from "./ReferenceCitationDot";
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
};

interface ReferencesProps {
  /** Explicit list of resource IDs to display */
  ids?: string[];
  /** Page ID — used to display citation health from build-time data */
  pageId?: string;
  /** Title for the section (default: "References") */
  title?: string;
  /** Additional class name */
  className?: string;
}

interface ResolvedRef {
  index: number;
  resource: Resource;
  credibility: number | undefined;
  publicationName: string | undefined;
  peerReviewed: boolean;
}

function resolveRefs(ids: string[]): {
  refs: ResolvedRef[];
  missing: string[];
} {
  const refs: ResolvedRef[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    const resource = getResourceById(id);
    if (!resource) {
      missing.push(id);
      continue;
    }

    const publication = getResourcePublication(resource);
    refs.push({
      index: refs.length + 1,
      resource,
      credibility: getResourceCredibility(resource),
      publicationName: publication?.name,
      peerReviewed: publication?.peer_reviewed ?? false,
    });
  }

  return { refs, missing };
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  if (authors.length <= 4) return authors.slice(0, -1).join(", ") + " & " + authors[authors.length - 1];
  return `${authors[0]} et al.`;
}

function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function ReferenceEntry({ entry }: { entry: ResolvedRef }) {
  const { resource, index, credibility, publicationName, peerReviewed } = entry;
  const year = resource.published_date?.slice(0, 4);
  const authorStr = resource.authors ? formatAuthors(resource.authors) : null;
  const typeLabel = TYPE_LABELS[resource.type];
  const domain = resource.url ? getDomain(resource.url) : null;

  // Metadata fragments: author · year · publication · type
  const metaParts: React.ReactNode[] = [];
  if (authorStr) {
    metaParts.push(<span key="author">{authorStr}</span>);
  }
  if (year) {
    metaParts.push(<span key="year">{year}</span>);
  }
  if (publicationName) {
    metaParts.push(
      <span key="pub" className="italic">
        {publicationName}
        {peerReviewed && " (peer-reviewed)"}
      </span>
    );
  }
  if (typeLabel) {
    metaParts.push(<span key="type">{typeLabel}</span>);
  }
  if (!publicationName && domain) {
    metaParts.push(
      <span key="domain" className="text-muted-foreground">{domain}</span>
    );
  }

  const metaLine = metaParts.length > 0 ? (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground mt-0.5">
      {metaParts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="opacity-30">{"\u00b7"}</span>}
          {part}
        </React.Fragment>
      ))}
    </span>
  ) : null;

  return (
    <li
      id={`ref-${index}`}
      className="py-1.5 border-b border-border last:border-b-0"
    >
      <details className="ref-details group">
        <summary className="ref-summary cursor-pointer select-none">
          <div className="flex items-start gap-2">
            <span className="flex items-center gap-1 shrink-0 mt-[3px]">
              {resource.url && <ReferenceCitationDot url={resource.url} />}
              <a
                href={`#cite-${index}`}
                className="text-xs font-mono text-muted-foreground no-underline hover:text-foreground tabular-nums"
                title={`Jump back to citation [${index}] in text`}
              >
                {index}
              </a>
            </span>
            <div className="flex-1 min-w-0">
              <span className="inline">
                <a
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-accent-foreground no-underline hover:underline leading-snug"
                >
                  {resource.title}
                </a>
                <span className="ref-chevron inline-block ml-1 text-muted-foreground text-xs transition-transform duration-150 align-middle opacity-40 group-hover:opacity-70">
                  {"\u25b8"}
                </span>
              </span>
              {metaLine}
            </div>
          </div>
        </summary>

        <div className="ml-7 mt-2 mb-1 border-l-2 border-border pl-3">
          {resource.summary && (
            <p className="text-xs text-muted-foreground leading-relaxed m-0">
              {resource.summary}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-2 empty:hidden">
            {credibility != null && (
              <CredibilityBadge level={credibility} size="sm" />
            )}
            {resource.tags && resource.tags.length > 0 && (
              <ResourceTags tags={resource.tags} limit={4} size="sm" />
            )}
          </div>
          {resource.url && (
            <ReferenceCitationDetails url={resource.url} />
          )}
        </div>
      </details>
    </li>
  );
}

function CitationHealthFooter({ pageId }: { pageId: string }) {
  const health = getPageCitationHealth(pageId);
  if (!health || health.total === 0) return null;

  const { total, accuracyChecked, accurate, inaccurate } = health;

  if (accuracyChecked === 0) return null;

  const parts: string[] = [];
  if (accurate > 0) parts.push(`${accurate} verified`);
  if (inaccurate > 0) parts.push(`${inaccurate} flagged`);
  const unchecked = total - accuracyChecked;
  if (unchecked > 0) parts.push(`${unchecked} unchecked`);

  let dotColor = "bg-muted-foreground";
  if (inaccurate > 0) dotColor = "bg-amber-500";
  else if (accurate > 0 && accurate / accuracyChecked >= 0.9) dotColor = "bg-emerald-500";
  else if (accurate > 0) dotColor = "bg-blue-500";

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-4 pt-3 border-t border-border">
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotColor)} />
      Citation verification: {parts.join(", ")} of {total} total
    </div>
  );
}

/**
 * <References> — Numbered bibliography section for wiki pages.
 *
 * Each entry becomes an anchor target (#ref-1, #ref-2, etc.)
 * so that <R n={1}> can link to the reference list.
 *
 * Entries are compact by default. Those with extra data (summary, tags)
 * have a ▸ chevron that expands to show details.
 */
export function References({
  ids = [],
  pageId,
  title = "References",
  className,
}: ReferencesProps) {
  if (ids.length === 0) return null;

  const { refs, missing } = resolveRefs(ids);

  return (
    <section
      className={cn(
        "mt-10 pt-6 border-t border-border",
        className
      )}
      aria-label={title}
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 mt-0 pb-0 border-b-0"
        id="references"
      >
        {title}
      </h2>

      {refs.length > 0 && (
        <ol className="list-none pl-0 m-0">
          {refs.map((r) => (
            <ReferenceEntry key={r.resource.id} entry={r} />
          ))}
        </ol>
      )}

      {missing.length > 0 && (
        <p className="text-xs text-destructive mt-3">
          Missing resources: {missing.join(", ")}
        </p>
      )}

      {pageId && <CitationHealthFooter pageId={pageId} />}
    </section>
  );
}

export default References;
