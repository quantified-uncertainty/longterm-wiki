import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  resolveResource,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
  getTypedEntityById,
  getPageById,
  getEntityHref,
  findPersonByName,
} from "@data";
import { getEntityTypeLabel } from "@data/entity-ontology";
import { fetchFromWikiServer, fetchDetailed, type RpcResourceDetailResult } from "@/lib/wiki-server";
import type { CitationContentResult } from "@wiki-server/api-response-types";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { getDomain } from "@/components/wiki/resource-utils";
import { renderInlineMarkdown, stripMarkdownFormatting } from "@/lib/inline-markdown";
import {
  ExternalLink,
  FileText,
  Database,
  ArrowLeft,
  User,
  BookOpen,
  Shield,
  Clock,
  Table2,
} from "lucide-react";
import { cn } from "@lib/utils";
import { safeHref } from "@/lib/directory-utils";
import { getFactIdsForResource } from "@/data/resource-fact-links";
import {
  getFactBaseFactById,
  getFactBaseEntity,
  getFactBaseProperty,
} from "@/data/factbase";
import { formatKBFactValue, formatKBDate } from "@/components/wiki/factbase/format";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import { formatAge } from "@/lib/format";

// Cache for 1 hour — these on-demand pages get heavy bot traffic with 0% cache hits.
export const revalidate = 3600;

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Resource detail from wiki-server — type inferred from Hono RPC route. */
type ServerResource = RpcResourceDetailResult;

/** Fetch a resource from the wiki-server by ID. Returns null on 404/not-configured. */
async function fetchServerResource(id: string): Promise<ServerResource | null> {
  const result = await fetchDetailed<ServerResource>(
    `/api/resources/${encodeURIComponent(id)}`,
    { revalidate: 3600 }
  );
  if (!result.ok) {
    // Log non-trivial errors (skip 404 and not-configured — those are expected)
    const err = result.error;
    if (err.type === "server-error" && err.status !== 404) {
      console.warn(`[resources/${id}] Wiki-server error: HTTP ${err.status}`);
    } else if (err.type === "connection-error") {
      console.warn(`[resources/${id}] Wiki-server connection error: ${err.message}`);
    }
    return null;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const localResource = resolveResource(id);
  if (localResource) {
    const plainTitle = stripMarkdownFormatting(localResource.title);
    return {
      title: `Source: ${plainTitle}`,
      description: localResource.summary || `Citation source: ${plainTitle}`,
      robots: { index: false, follow: false },
    };
  }

  // Try wiki-server for resources not in local data (e.g., tabular sources)
  const serverResource = await fetchServerResource(id);
  if (serverResource) {
    return {
      title: `Source: ${serverResource.title ?? id}`,
      description: serverResource.summary || `Data source: ${serverResource.title ?? id}`,
      robots: { index: false, follow: false },
    };
  }

  return { title: "Source Not Found" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Resolve a page slug to its display title */
function getPageTitle(pageId: string): string {
  const entity = getTypedEntityById(pageId);
  if (entity?.title) return entity.title;
  const page = getPageById(pageId);
  if (page?.title) return page.title;
  return pageId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const CREDIBILITY_DESCRIPTIONS: Record<number, string> = {
  5: "Gold standard. Rigorous peer review, high editorial standards, and strong institutional reputation.",
  4: "High quality. Established institution or organization with editorial oversight and accountability.",
  3: "Good quality. Reputable source with community review or editorial standards, but less rigorous than peer-reviewed venues.",
  2: "Mixed quality. Some useful content but inconsistent editorial standards. Claims should be verified.",
  1: "Low credibility. Unvetted or unreliable source. Use with caution and always cross-reference.",
};

function AuthorName({ name }: { name: string }) {
  const personEntityId = findPersonByName(name);
  if (personEntityId) {
    const href = getEntityHref(personEntityId);
    return (
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
      >
        <User className="w-3 h-3" />
        {name}
      </Link>
    );
  }
  return <span>{name}</span>;
}

import { FORMAT_LABELS, RECORD_TYPE_LABELS } from "@/app/data-sources/data-source-labels";

// ---------------------------------------------------------------------------
// Server-fetched resource page (tabular sources, etc.)
// ---------------------------------------------------------------------------

function ServerResourcePage({ resource }: { resource: ServerResource }) {
  const ts = resource.tabularSource;
  const publisherInfo = resource.publisherEntityId
    ? resolveEntityName(resource.publisherEntityId)
    : null;
  const isTabular = ts != null;
  const hasExternalUrl = resource.url && !resource.url.startsWith("urn:");

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Back link */}
      <Link
        href={isTabular ? "/wiki/E2131" : "/resources"}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {isTabular ? "Data Sources" : "Back"}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-3 mb-1.5">
          <h1 className="text-2xl font-bold">{resource.title ?? resource.id}</h1>
          {isTabular && (
            <span className="shrink-0 mt-1 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 font-medium">
              <Database className="w-3 h-3" />
              Data Source
            </span>
          )}
          {!isTabular && resource.type && (
            <span className="shrink-0 mt-1 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium capitalize">
              <FileText className="w-3 h-3" />
              {resource.type}
            </span>
          )}
        </div>

        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {publisherInfo && (
            <span className="inline-flex items-center gap-1.5">
              {publisherInfo.href ? (
                <Link
                  href={publisherInfo.href}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {publisherInfo.name}
                </Link>
              ) : (
                <span>{publisherInfo.name}</span>
              )}
            </span>
          )}
          {hasExternalUrl && (
            <span className="inline-flex items-center gap-1.5">
              {publisherInfo && (
                <span className="text-muted-foreground/30">&middot;</span>
              )}
              <a
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                {(() => {
                  try {
                    const u = new URL(resource.url);
                    return u.hostname;
                  } catch {
                    return resource.url;
                  }
                })()}
              </a>
            </span>
          )}
        </div>
      </div>

      {/* Summary */}
      {resource.summary && (
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">
          {resource.summary}
        </p>
      )}

      {/* Tabular Source Details */}
      {ts && (
        <section className="mb-6 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <Table2 className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Data Source Details
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Format</div>
              <div className="font-medium">{FORMAT_LABELS[ts.dataFormat] ?? ts.dataFormat}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Record Type</div>
              <div className="font-medium">{RECORD_TYPE_LABELS[ts.recordType] ?? ts.recordType}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Update Frequency</div>
              <div className="font-medium capitalize">{ts.updateFrequency ?? "Unknown"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Status</div>
              <div className={cn(
                "font-medium capitalize",
                ts.sourceStatus === "active" && "text-blue-600",
                ts.sourceStatus === "archived" && "text-muted-foreground",
                ts.sourceStatus === "defunct" && "text-red-600",
              )}>
                {ts.sourceStatus}
              </div>
            </div>
          </div>

          {/* Snapshot stats */}
          <div className="mt-4 pt-4 border-t border-border/60 grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last Snapshot
              </div>
              <div className="font-medium">
                {ts.lastSnapshotAt ? formatAge(ts.lastSnapshotAt) : "Never"}
              </div>
              {ts.lastSnapshotAt && (
                <div className="text-xs text-muted-foreground">
                  {formatDate(ts.lastSnapshotAt)}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Database className="w-3 h-3" />
                Records
              </div>
              <div className="font-bold tabular-nums text-lg">
                {ts.snapshotRecordCount?.toLocaleString() ?? "—"}
              </div>
            </div>
            {ts.recordType === "grant" && (
              <div className="flex items-end">
                <Link
                  href={`/grants?dataSource=${ts.sourceSlug}`}
                  className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View all grants
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Data Preview */}
      {ts?.previewHeaders && ts.previewRows && ts.previewRows.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <Table2 className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Data Preview
            <span className="text-xs font-normal ml-2">
              (first {ts.previewRows.length} of {ts.snapshotRecordCount?.toLocaleString() ?? "?"} rows)
            </span>
          </h2>
          <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  {ts.previewHeaders.slice(0, 8).map((header, idx) => (
                    <th
                      key={`${header}-${idx}`}
                      className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                    >
                      {header}
                    </th>
                  ))}
                  {ts.previewHeaders.length > 8 && (
                    <th className="text-left px-3 py-2 text-xs text-muted-foreground/50">
                      +{ts.previewHeaders.length - 8} more
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {ts.previewRows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-border hover:bg-muted/30 transition-colors"
                  >
                    {row.slice(0, 8).map((cell, j) => (
                      <td
                        key={j}
                        className="px-3 py-2 text-xs max-w-[200px] truncate"
                        title={cell}
                      >
                        {cell || <span className="text-muted-foreground/40">—</span>}
                      </td>
                    ))}
                    {ts.previewHeaders!.length > 8 && (
                      <td className="px-3 py-2 text-xs text-muted-foreground/50">...</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cited By (from wiki-server) */}
      {resource.citedBy.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Cited by {resource.citedBy.length} page
            {resource.citedBy.length !== 1 ? "s" : ""}
          </h2>
          <div className="rounded-lg border border-border overflow-hidden">
            <ul className="divide-y divide-border">
              {resource.citedBy.map((pageSlug) => {
                const title = getPageTitle(pageSlug);
                const entity = getTypedEntityById(pageSlug);
                const href = getEntityHref(pageSlug, entity?.entityType);
                return (
                  <li key={pageSlug} className="px-4 py-2 hover:bg-muted/30 transition-colors">
                    <Link
                      href={href}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium"
                    >
                      {title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        Resource ID: <code className="px-1 py-0.5 bg-muted rounded">{resource.id}</code>
        {resource.stableId && (
          <> | Stable ID: <code className="px-1 py-0.5 bg-muted rounded">{resource.stableId}</code></>
        )}
        {ts && (
          <> | Source Slug: <code className="px-1 py-0.5 bg-muted rounded">{ts.sourceSlug}</code></>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local resource page (existing behavior for literature resources)
// ---------------------------------------------------------------------------

export default async function ResourcePage({ params }: PageProps) {
  const { id } = await params;
  const resource = resolveResource(id);

  // Fallback to wiki-server for resources not in local data (e.g., tabular sources)
  if (!resource) {
    const serverResource = await fetchServerResource(id);
    if (!serverResource) notFound();
    return <ServerResourcePage resource={serverResource} />;
  }

  const publication = getResourcePublication(resource);
  const credibility = getResourceCredibility(resource);
  const citingPages = getPagesForResource(resource.id);
  const domain = resource.url ? (getDomain(resource.url) ?? "unknown") : null;

  // Fetch cached content
  const contentData = resource.url
    ? await fetchFromWikiServer<CitationContentResult>(
        `/api/citations/content?url=${encodeURIComponent(resource.url)}`,
        { revalidate: 3600 }
      )
    : null;

  // Determine whether content sections exist
  const hasAbstract = !!resource.abstract;
  const hasSummary = !!resource.summary;
  const hasKeyPoints = resource.key_points && resource.key_points.length > 0;
  const hasReview = !!resource.review;
  const hasContentSections = hasAbstract || hasSummary || hasKeyPoints || hasReview;
  const hasAuthors = resource.authors && resource.authors.length > 0;

  // Get FactBase facts that cite this resource's URL
  const citingFactIds = getFactIdsForResource(resource.id);
  const citingFacts = citingFactIds
    .map((factId) => {
      const fact = getFactBaseFactById(factId);
      if (!fact) return null;
      const entity = getFactBaseEntity(fact.subjectId);
      const property = getFactBaseProperty(fact.propertyId);
      return {
        factId: fact.id,
        entityName: entity?.name ?? fact.subjectId,
        entityId: fact.subjectId,
        propertyName: property?.name ?? fact.propertyId,
        formattedValue: formatKBFactValue(fact, property?.unit, property?.display),
        asOf: formatKBDate(fact.asOf),
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  // Build citing page info for the table
  const citingPageInfo = citingPages.map((pageId) => {
    const entity = getTypedEntityById(pageId);
    const page = getPageById(pageId);
    const href = getEntityHref(pageId, entity?.entityType);
    const title = getPageTitle(pageId);
    const entityType = entity?.entityType ?? null;
    const quality = page?.quality ?? null;
    return { pageId, href, title, entityType, quality };
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Back link */}
      <Link
        href="/resources"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-3 mb-1.5">
          <h1 className="text-2xl font-bold">{stripMarkdownFormatting(resource.title)}</h1>
          {resource.type && (
            <span className="shrink-0 mt-1 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium capitalize">
              <FileText className="w-3 h-3" />
              {resource.type}
            </span>
          )}
        </div>

        {/* Metadata row — year, publication, URL */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {resource.published_date && (
            <span>{resource.published_date.slice(0, 4)}</span>
          )}
          {publication && (
            <span className="inline-flex items-center gap-1.5">
              {resource.published_date && (
                <span className="text-muted-foreground/30">&middot;</span>
              )}
              <Link
                href={`/publications/${publication.id}`}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {publication.name}
              </Link>
              {publication.peer_reviewed && (
                <span className="text-emerald-600 dark:text-emerald-400 text-xs">(peer-reviewed)</span>
              )}
            </span>
          )}
          {!publication && domain && (
            <span className="inline-flex items-center gap-1.5">
              {resource.published_date && (
                <span className="text-muted-foreground/30">&middot;</span>
              )}
              <span>{domain}</span>
            </span>
          )}
          {resource.url && (() => {
            const shortUrl = resource.url.replace(/^https?:\/\/(www\.)?/, "");
            const displayUrl = shortUrl.length > 60 ? shortUrl.slice(0, 57) + "..." : shortUrl;
            return (
              <span className="inline-flex items-center gap-1.5">
                {(resource.published_date || publication || domain) && (
                  <span className="text-muted-foreground/30">&middot;</span>
                )}
                <a
                  href={safeHref(resource.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  {displayUrl}
                </a>
              </span>
            );
          })()}
        </div>
      </div>

      {/* Authors section */}
      {hasAuthors && (
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            <User className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
            {resource.authors!.length === 1 ? "Author" : "Authors"}
          </h2>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
            {resource.authors!.map((author, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground/30">&middot;</span>}
                <AuthorName name={author} />
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Credibility section — prominent display */}
      {credibility != null && (
        <section className="mb-6 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <Shield className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Credibility Rating
          </h2>
          <div className="flex items-start gap-4">
            <div className="shrink-0 text-center">
              <div className="text-3xl font-bold tabular-nums">
                {credibility}/5
              </div>
              <CredibilityBadge
                level={credibility}
                size="md"
                showLabel
                className="mt-1"
              />
            </div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              <p>
                {CREDIBILITY_DESCRIPTIONS[Math.max(1, Math.min(5, Math.round(credibility)))] ??
                  CREDIBILITY_DESCRIPTIONS[3]}
              </p>
              {publication && (
                <p className="mt-1.5 text-xs text-muted-foreground/70">
                  Rating inherited from publication venue:{" "}
                  <Link
                    href={`/publications/${publication.id}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {publication.name}
                  </Link>
                </p>
              )}
              {resource.credibility_override !== undefined && (
                <p className="mt-1.5 text-xs text-muted-foreground/70">
                  This resource has a direct credibility override.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Context Note */}
      {resource.context_note && (
        <section className="mb-6 p-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30">
          <p className="text-sm text-blue-700 dark:text-blue-300 italic">
            {resource.context_note}
          </p>
        </section>
      )}

      {/* Paper-specific section */}
      {resource.paper && (
        <section className="mb-6 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Paper Details
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            {resource.paper.citation_count != null && (
              <div>
                <div className="text-xs text-muted-foreground">Citations</div>
                <div className="font-semibold tabular-nums">{resource.paper.citation_count.toLocaleString()}</div>
                {resource.paper.influential_citation_count != null && (
                  <div className="text-xs text-muted-foreground">
                    {resource.paper.influential_citation_count} influential
                  </div>
                )}
              </div>
            )}
            {resource.paper.year != null && (
              <div>
                <div className="text-xs text-muted-foreground">Year</div>
                <div className="font-semibold tabular-nums">{resource.paper.year}</div>
              </div>
            )}
            {resource.paper.methodology && (
              <div>
                <div className="text-xs text-muted-foreground">Methodology</div>
                <div className="capitalize">{resource.paper.methodology}</div>
              </div>
            )}
            {resource.paper.categories && resource.paper.categories.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground">Categories</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {resource.paper.categories.map((cat) => (
                    <span key={cat} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {cat}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-3 mt-3">
            {resource.paper.arxiv_id && (
              <a
                href={`https://arxiv.org/abs/${resource.paper.arxiv_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                arXiv:{resource.paper.arxiv_id}
              </a>
            )}
            {resource.paper.doi && (
              <a
                href={`https://doi.org/${resource.paper.doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                DOI:{resource.paper.doi}
              </a>
            )}
            {resource.paper.semantic_scholar_id && (
              <a
                href={`https://www.semanticscholar.org/paper/${resource.paper.semantic_scholar_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                Semantic Scholar
              </a>
            )}
          </div>
        </section>
      )}

      {/* Forum post-specific section */}
      {resource.forum_post && (
        <section className="mb-6 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Forum Post Details
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            {resource.forum_post.karma != null && (
              <div>
                <div className="text-xs text-muted-foreground">Karma</div>
                <div className="font-semibold tabular-nums">{resource.forum_post.karma}</div>
              </div>
            )}
            {resource.forum_post.comment_count != null && (
              <div>
                <div className="text-xs text-muted-foreground">Comments</div>
                <div className="font-semibold tabular-nums">{resource.forum_post.comment_count}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground">Forum</div>
              <div className="capitalize">{resource.forum_post.forum}</div>
            </div>
            {resource.forum_post.curated && (
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                  Curated
                </span>
              </div>
            )}
          </div>
          {resource.forum_post.forum_tags && resource.forum_post.forum_tags.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-muted-foreground mb-1">Forum Tags</div>
              <div className="flex flex-wrap gap-1">
                {resource.forum_post.forum_tags.map((tag) => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
          {resource.forum_post.sequence_title && (
            <div className="mt-2 text-xs text-muted-foreground">
              Part of sequence: <span className="font-medium text-foreground">{resource.forum_post.sequence_title}</span>
            </div>
          )}
        </section>
      )}

      {/* Policy doc-specific section */}
      {resource.policy_doc && (
        <section className="mb-6 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Policy Document Details
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            {resource.policy_doc.document_type && (
              <div>
                <div className="text-xs text-muted-foreground">Document Type</div>
                <div className="capitalize">{resource.policy_doc.document_type.replace(/_/g, " ")}</div>
              </div>
            )}
            {resource.policy_doc.document_status && (
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="capitalize">{resource.policy_doc.document_status}</div>
              </div>
            )}
            {resource.policy_doc.reference_number && (
              <div>
                <div className="text-xs text-muted-foreground">Reference</div>
                <div className="font-mono">{resource.policy_doc.reference_number}</div>
              </div>
            )}
            {resource.policy_doc.effective_date && (
              <div>
                <div className="text-xs text-muted-foreground">Effective Date</div>
                <div>{resource.policy_doc.effective_date}</div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Data Status Banner */}
      <section className="mb-6 p-4 rounded-lg border border-border bg-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Metadata
        </h2>
        <div className="flex flex-wrap gap-3">
          {resource.importance_score != null && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              Importance: {Math.round(resource.importance_score * 100)}/100
            </span>
          )}
          {resource.resource_subtype && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
              {resource.resource_subtype.replace(/_/g, ' ')}
            </span>
          )}
          {resource.resource_purpose && resource.resource_purpose !== resource.resource_subtype && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
              {resource.resource_purpose.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </section>

      {/* Content sections — consolidated in a bordered container */}
      {hasContentSections && (
        <section className="mb-6 rounded-lg border border-border overflow-hidden">
          {hasAbstract && (
            <div className="px-5 py-4 border-b border-border last:border-b-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Abstract
              </h3>
              <p className="text-sm leading-relaxed text-foreground/90">
                {renderInlineMarkdown(resource.abstract!)}
              </p>
            </div>
          )}
          {hasSummary && (
            <div className="px-5 py-4 border-b border-border last:border-b-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Summary
              </h3>
              <p className="text-sm leading-relaxed text-foreground/90">
                {renderInlineMarkdown(resource.summary!)}
              </p>
            </div>
          )}
          {hasKeyPoints && (
            <div className="px-5 py-4 border-b border-border last:border-b-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Key Points
              </h3>
              <ul className="space-y-1.5">
                {resource.key_points!.map((point, i) => (
                  <li
                    key={i}
                    className="text-sm leading-relaxed text-foreground/90 flex items-start gap-2"
                  >
                    <span className="text-muted-foreground/40 mt-0.5 shrink-0">&bull;</span>
                    <span>{renderInlineMarkdown(point)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasReview && (
            <div className="px-5 py-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Review
              </h3>
              <div className="text-sm leading-relaxed text-foreground/90 whitespace-pre-line">
                {renderInlineMarkdown(resource.review!)}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Cited By table */}
      {citingPageInfo.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Cited by {citingPageInfo.length} page
            {citingPageInfo.length !== 1 ? "s" : ""}
          </h2>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Page
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Type
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Quality
                  </th>
                </tr>
              </thead>
              <tbody>
                {citingPageInfo.map(({ pageId, href, title, entityType, quality }) => (
                  <tr
                    key={pageId}
                    className="border-t border-border hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={href}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {title}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {entityType ? (
                        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted capitalize">
                          {getEntityTypeLabel(entityType)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">--</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {quality != null ? (
                        <span>{quality.toFixed(1)}</span>
                      ) : (
                        <span className="text-muted-foreground/50">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* FactBase facts citing this source */}
      {citingFacts.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <Database className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            {citingFacts.length} FactBase fact
            {citingFacts.length !== 1 ? "s" : ""} citing this source
          </h2>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Entity
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Property
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Value
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    As Of
                  </th>
                </tr>
              </thead>
              <tbody>
                {citingFacts.map(({ factId, entityName, entityId, propertyName, formattedValue, asOf }) => (
                  <tr
                    key={factId}
                    className="border-t border-border hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/factbase/entity/${entityId}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {entityName}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {propertyName}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/factbase/fact/${factId}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                      >
                        {formattedValue}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                      {asOf}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Cached content preview */}
      {contentData?.fullTextPreview && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Cached Content Preview
          </h2>
          <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
            {contentData.httpStatus && (
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-mono",
                  contentData.httpStatus === 200
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                )}
              >
                HTTP {contentData.httpStatus}
              </span>
            )}
            {contentData.fetchedAt && (
              <span>Fetched {formatDate(contentData.fetchedAt)}</span>
            )}
            {contentData.contentLength && (
              <span>
                {Math.round(contentData.contentLength / 1024)} KB
              </span>
            )}
          </div>
          <div className="p-4 rounded-lg border border-border bg-muted/30 max-h-96 overflow-y-auto">
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {contentData.fullTextPreview.slice(0, 3000)}
              {contentData.fullTextPreview.length > 3000 && (
                <span className="text-muted-foreground/50">
                  {"\n\n"}... (truncated{contentData.contentLength != null ? `, ${Math.round(contentData.contentLength / 1024)} KB total` : ""})
                </span>
              )}
            </pre>
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        Resource ID: <code className="px-1 py-0.5 bg-muted rounded">{resource.id}</code>
        {resource.stable_id && (
          <> | Stable ID: <code className="px-1 py-0.5 bg-muted rounded">{resource.stable_id}</code></>
        )}
      </div>
    </div>
  );
}
