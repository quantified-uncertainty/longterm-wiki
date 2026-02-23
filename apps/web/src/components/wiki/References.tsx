import React from "react";
import {
  getResourceById,
  getResourcePublication,
  getPageCitationHealth,
} from "@data";
import type { Resource } from "@data";
import { cn } from "@lib/utils";

interface ReferencesProps {
  /** Explicit list of resource IDs to display */
  ids?: string[];
  /** Page ID — used to display citation health from build-time data */
  pageId?: string;
  /** Title for the section (default: "References") */
  title?: string;
  /** Show summaries (default: false — keeps bibliography compact) */
  showSummaries?: boolean;
  /** Additional class name */
  className?: string;
}

interface ResolvedRef {
  index: number;
  resource: Resource;
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
  return `${authors[0]} et al.`;
}

function ReferenceEntry({
  entry,
  showSummaries,
}: {
  entry: ResolvedRef;
  showSummaries: boolean;
}) {
  const { resource, index, publicationName, peerReviewed } = entry;
  const year = resource.published_date?.slice(0, 4);
  const authorStr = resource.authors ? formatAuthors(resource.authors) : null;

  return (
    <li
      id={`ref-${index}`}
      className="my-1.5 leading-relaxed text-sm text-muted-foreground"
    >
      <a
        href={`#cite-${index}`}
        className="text-xs font-mono text-muted-foreground no-underline hover:text-foreground mr-1.5"
        title="Jump to citation in text"
      >
        {index}.
      </a>
      {authorStr && (
        <span>{authorStr}</span>
      )}
      {year && (
        <span>{authorStr ? " " : ""}({year}){authorStr || publicationName ? ". " : " "}</span>
      )}
      {!year && authorStr && ". "}
      <a
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-foreground no-underline hover:underline"
      >
        {resource.title}
      </a>
      {publicationName && (
        <span className="italic">
          . {publicationName}
          {peerReviewed && " (peer-reviewed)"}
        </span>
      )}
      {showSummaries && resource.summary && (
        <span className="block text-xs text-muted-foreground/70 mt-0.5 leading-snug ml-5">
          {resource.summary}
        </span>
      )}
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
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-3 pt-2">
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotColor)} />
      Citation verification: {parts.join(", ")} of {total} total
    </p>
  );
}

/**
 * <References> — Numbered bibliography section for wiki pages.
 *
 * Usage in MDX:
 *   <References ids={["abc123", "def456"]} />
 *   <References ids={["abc123", "def456"]} pageId="lock-in" />
 *
 * Each entry becomes an anchor target (#ref-1, #ref-2, etc.)
 * so that <R n={1}> can link to the reference list.
 *
 * Citation health stats (verified/flagged/unchecked) come from build-time
 * data in database.json. Per-citation verification is handled separately
 * by the CitationOverlay client component on footnote references.
 */
export function References({
  ids = [],
  pageId,
  title = "References",
  showSummaries = false,
  className,
}: ReferencesProps) {
  if (ids.length === 0) return null;

  const { refs, missing } = resolveRefs(ids);

  return (
    <section
      className={cn(
        "mt-10 pt-6 border-t border-border text-sm text-muted-foreground",
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
        <ol className="list-none pl-7 m-0">
          {refs.map((r) => (
            <ReferenceEntry
              key={r.resource.id}
              entry={r}
              showSummaries={showSummaries}
            />
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
