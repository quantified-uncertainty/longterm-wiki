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

function ReferenceEntry({ entry }: { entry: ResolvedRef }) {
  const { resource, index, credibility, publicationName, peerReviewed } = entry;
  const year = resource.published_date?.slice(0, 4);
  const authorStr = resource.authors ? formatAuthors(resource.authors) : null;
  const typeLabel = TYPE_LABELS[resource.type] || resource.type;

  return (
    <li
      id={`ref-${index}`}
      className="py-2.5 border-b border-border/30 last:border-b-0"
    >
      <div className="flex items-start gap-2">
        <a
          href={`#cite-${index}`}
          className="shrink-0 text-xs font-mono text-muted-foreground/60 no-underline hover:text-foreground mt-0.5 w-5 text-right"
          title="Jump to citation in text"
        >
          {index}
        </a>

        <div className="flex-1 min-w-0">
          {/* Title line */}
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-accent-foreground no-underline hover:underline leading-snug"
          >
            {resource.title}
          </a>

          {/* Metadata line: type, authors, year, publication */}
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground mt-0.5">
            <span className="text-muted-foreground/50">{typeLabel}</span>
            {authorStr && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span>{authorStr}</span>
              </>
            )}
            {year && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span>{year}</span>
              </>
            )}
            {publicationName && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="italic">
                  {publicationName}
                  {peerReviewed && " (peer-reviewed)"}
                </span>
              </>
            )}
          </div>

          {/* Summary */}
          {resource.summary && (
            <p className="text-xs text-muted-foreground/70 mt-1 leading-snug m-0">
              {resource.summary}
            </p>
          )}

          {/* Badges: credibility + tags */}
          {(credibility != null || (resource.tags && resource.tags.length > 0)) && (
            <div className="flex items-center gap-1.5 mt-1.5">
              {credibility != null && (
                <CredibilityBadge level={credibility} size="sm" />
              )}
              {resource.tags && resource.tags.length > 0 && (
                <ResourceTags tags={resource.tags} limit={3} size="sm" />
              )}
            </div>
          )}
        </div>
      </div>
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
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-3 pt-2 m-0">
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotColor)} />
      Citation verification: {parts.join(", ")} of {total} total
    </p>
  );
}

/**
 * <References> — Numbered bibliography section for wiki pages.
 *
 * Each entry becomes an anchor target (#ref-1, #ref-2, etc.)
 * so that <R n={1}> can link to the reference list.
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
        className="text-base font-semibold mb-3 mt-0 pb-0 border-b-0"
        id="references"
      >
        {title}
      </h2>

      {refs.length > 0 && (
        <ul style={{ listStyleType: "none" }} className="pl-0 m-0">
          {refs.map((r) => (
            <ReferenceEntry key={r.resource.id} entry={r} />
          ))}
        </ul>
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
