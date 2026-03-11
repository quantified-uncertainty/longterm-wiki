import React from "react";
import {
  resolveResource,
  getResourceCredibility,
  getResourcePublication,
  getPageCitationHealth,
  getResourcesForPage,
} from "@data";
import type { Resource } from "@data";
import { CredibilityBadge } from "./CredibilityBadge";
import { ReferenceCitationDetails } from "./ReferenceCitationDetails";
import { ReferenceCitationDot } from "./ReferenceCitationDot";
import { formatAuthors, getDomain, isSafeUrl } from "./resource-utils";
import { cn } from "@lib/utils";
import { ExternalLink } from "lucide-react";

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
  const seenInput = new Set<string>();
  const seenResourceId = new Set<string>();

  for (const id of ids) {
    if (seenInput.has(id)) continue;
    seenInput.add(id);

    const resource = resolveResource(id);
    if (!resource) {
      missing.push(id);
      continue;
    }

    // Dedup by resolved resource ID — same resource referenced by hash + stable_id
    if (seenResourceId.has(resource.id)) continue;
    seenResourceId.add(resource.id);

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

function ReferenceEntry({ entry, pageId }: { entry: ResolvedRef; pageId?: string }) {
  const { resource, index, credibility, publicationName, peerReviewed } = entry;
  const year = resource.published_date?.slice(0, 4);
  const authorStr = resource.authors ? formatAuthors(resource.authors) : null;
  const typeLabel = TYPE_LABELS[resource.type];
  const domain = resource.url ? getDomain(resource.url) : null;

  // Metadata fragments: source . author . year . type (source first, type last)
  const metaParts: React.ReactNode[] = [];
  if (publicationName) {
    metaParts.push(
      <span key="pub" className="italic">
        {publicationName}
        {peerReviewed && " (peer-reviewed)"}
      </span>
    );
  } else if (domain) {
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

  // Only show expand arrow + details if there's content to expand
  const hasExpandableContent = !!resource.summary || credibility != null || !!resource.url;

  const titleRow = (
    <div className="flex items-baseline gap-1">
      {/* Number gutter -- lighter than title text */}
      <span className="shrink-0 w-7 text-xs font-mono text-muted-foreground/50 tabular-nums text-right pr-2">
        <a
          href={`#cite-${index}`}
          className="!no-underline !decoration-0 text-muted-foreground/50 hover:text-foreground"
          title={`Jump back to citation [${index}] in text`}
        >
          {index}
        </a>
      </span>
      {/* Title + verification dot + meta */}
      <span className="flex-1 min-w-0">
        {resource.id ? (
          <a
            href={`/source/${resource.id}`}
            className="text-[13px] text-foreground/80 font-medium !no-underline hover:!underline leading-relaxed"
          >
            {resource.title}
          </a>
        ) : resource.url && isSafeUrl(resource.url) ? (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-foreground/80 font-medium !no-underline hover:!underline leading-relaxed"
          >
            {resource.title}
          </a>
        ) : (
          <span className="text-[13px] text-foreground/80 font-medium leading-relaxed">
            {resource.title}
          </span>
        )}
        {resource.url && <ReferenceCitationDot url={resource.url} />}
        {metaParts.length > 0 && (
          <span className="text-[11px] text-muted-foreground/60 ml-1.5">
            {metaParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="opacity-30 mx-1">{"\u00b7"}</span>}
                {part}
              </React.Fragment>
            ))}
          </span>
        )}
      </span>
      {hasExpandableContent && (
        <span className="ref-chevron shrink-0 ml-1 text-muted-foreground/30 text-[10px] transition-transform duration-200 group-hover:text-muted-foreground/60">
          {"\u25b8"}
        </span>
      )}
    </div>
  );

  if (!hasExpandableContent) {
    return (
      <div
        id={`ref-${index}`}
        className="py-1.5 border-b border-border/50 last:border-b-0"
      >
        <div className="-mx-1.5 px-1.5 py-0.5">
          {titleRow}
        </div>
      </div>
    );
  }

  return (
    <div
      id={`ref-${index}`}
      className="py-1.5 border-b border-border/50 last:border-b-0"
    >
      <details className="ref-details group">
        <summary className="ref-summary cursor-pointer select-none hover:bg-muted/40 -mx-2 px-2 py-0.5 rounded-md transition-colors">
          {titleRow}
        </summary>

        <div className="mt-1.5 mb-1 ml-7 pl-2 border-l-2 border-border/30">
          {resource.summary && (
            <p className="text-xs text-muted-foreground/70 leading-relaxed m-0">
              {resource.summary}
            </p>
          )}
          {credibility != null && (
            <div className="mt-1.5">
              <CredibilityBadge level={credibility} size="sm" />
            </div>
          )}
          {resource.url && isSafeUrl(resource.url) && (
            <div className="mt-1.5 flex items-center gap-2">
              <a
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-blue-600/70 hover:text-blue-600 transition-colors !no-underline"
              >
                <ExternalLink className="w-3 h-3" />
                <span className="truncate max-w-[250px]">{getDomain(resource.url)}</span>
              </a>
            </div>
          )}
          {resource.url && (
            <ReferenceCitationDetails url={resource.url} pageId={pageId} />
          )}
        </div>
      </details>
    </div>
  );
}

async function CitationHealthFooter({ pageId }: { pageId: string }) {
  const health = await getPageCitationHealth(pageId);
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
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-3 pt-2 border-t border-border/50">
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", dotColor)} />
      Citation verification: {parts.join(", ")} of {total} total
    </div>
  );
}

/**
 * <References> -- Numbered bibliography section for wiki pages.
 *
 * Each entry becomes an anchor target (#ref-1, #ref-2, etc.)
 * so that <R n={1}> can link to the reference list.
 *
 * Entries are compact by default. Those with extra data (summary, tags)
 * have a chevron that expands to show details.
 */
export function References({
  ids,
  pageId,
  title = "References",
  className,
}: ReferencesProps) {
  // Auto-discover resource IDs from build-time data when none explicitly provided
  const resolvedIds = ids && ids.length > 0
    ? ids
    : pageId
      ? getResourcesForPage(pageId)
      : [];

  if (resolvedIds.length === 0) return null;

  const { refs, missing } = resolveRefs(resolvedIds);

  return (
    <section
      className={cn(
        "mt-10 pt-6 border-t border-border",
        className
      )}
      aria-label={title}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mt-0 pb-0 border-b-0"
          id="references"
        >
          {title}
        </h2>
      </div>

      {refs.length > 0 && (
        <div>
          {refs.map((r) => (
            <ReferenceEntry key={r.resource.id} entry={r} pageId={pageId} />
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <p className="text-xs text-destructive mt-2">
          Missing resources: {missing.join(", ")}
        </p>
      )}

      {pageId && <CitationHealthFooter pageId={pageId} />}
    </section>
  );
}

export default References;