import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  resolveResource,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
  getEntityById,
  getPageById,
  getEntityHref,
  getTypedEntityById,
  findPersonByName,
} from "@data";
import { getEntityTypeLabel } from "@data/entity-ontology";
import { fetchFromWikiServer } from "@/lib/wiki-server";
import type { CitationContentResult } from "@wiki-server/api-response-types";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { getDomain } from "@/components/wiki/resource-utils";
import { renderInlineMarkdown } from "@/lib/inline-markdown";
import {
  ExternalLink,
  Clock,
  FileText,
  Link2,
  Download,
  Database,
  FileQuestion,
  ArrowLeft,
  User,
  BookOpen,
  Shield,
} from "lucide-react";
import { cn } from "@lib/utils";
import { safeHref } from "@/lib/directory-utils";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const resource = resolveResource(id);
  if (!resource) return { title: "Source Not Found" };

  return {
    title: `Source: ${resource.title}`,
    description: resource.summary || `Citation source: ${resource.title}`,
    robots: { index: false, follow: false },
  };
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

/** Resolve a page slug to its display title */
function getPageTitle(pageId: string): string {
  const entity = getEntityById(pageId);
  if (entity?.title) return entity.title;
  const page = getPageById(pageId);
  if (page?.title) return page.title;
  // Fall back to formatting the slug
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

/** Resolve an author name to a linked element or plain text */
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

export default async function ResourcePage({ params }: PageProps) {
  const { id } = await params;
  const resource = resolveResource(id);

  if (!resource) notFound();

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

  // Build citing page info for the table
  const citingPageInfo = citingPages.map((pageId) => {
    const entity = getEntityById(pageId);
    const typedEntity = getTypedEntityById(pageId);
    const page = getPageById(pageId);
    const href = getEntityHref(pageId, entity?.type);
    const title = getPageTitle(pageId);
    const entityType = typedEntity?.entityType ?? entity?.type ?? null;
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
          <h1 className="text-2xl font-bold">{resource.title}</h1>
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

      {/* Data Status Banner */}
      <section className="mb-6 p-4 rounded-lg border border-border bg-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Data Status
        </h2>
        <div className="flex flex-wrap gap-3">
          {/* Fetch status */}
          {resource.local_filename ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              <Download className="w-3 h-3" />
              Full text fetched
            </span>
          ) : resource.fetched_at ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              <Database className="w-3 h-3" />
              Metadata only
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
              <FileQuestion className="w-3 h-3" />
              Not fetched
            </span>
          )}
          {/* Fetched date */}
          {resource.fetched_at && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
              <Clock className="w-3 h-3" />
              Fetched {formatDate(resource.fetched_at)}
            </span>
          )}
        </div>
      </section>

      {/* Content sections — consolidated in a bordered container */}
      {hasContentSections && (
        <section className="mb-6 rounded-lg border border-border overflow-hidden">
          {/* Abstract */}
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

          {/* Summary */}
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

          {/* Key Points */}
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
                    <span className="text-muted-foreground/40 mt-0.5 shrink-0">
                      &bull;
                    </span>
                    <span>{renderInlineMarkdown(point)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Review */}
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
