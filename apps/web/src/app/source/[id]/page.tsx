import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
  getEntityById,
  getPageById,
  getEntityHref,
} from "@data";
import { getCitationQuotesByUrl } from "@/lib/citation-data";
import { fetchFromWikiServer } from "@/lib/wiki-server";
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
} from "lucide-react";
import { cn } from "@lib/utils";
import { CollapsibleClaims } from "./CollapsibleClaims";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const resource = getResourceById(id);
  if (!resource) return { title: "Source Not Found" };

  return {
    title: `Source: ${resource.title}`,
    description: resource.summary || `Citation source: ${resource.title}`,
    robots: { index: false, follow: false },
  };
}

interface CitationContentData {
  url: string;
  fetchedAt: string;
  httpStatus: number | null;
  pageTitle: string | null;
  fullTextPreview: string | null;
  contentLength: number | null;
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

export default async function SourcePage({ params }: PageProps) {
  const { id } = await params;
  const resource = getResourceById(id);

  if (!resource) notFound();

  const publication = getResourcePublication(resource);
  const credibility = getResourceCredibility(resource);
  const citingPages = getPagesForResource(id);
  const domain = resource.url ? (getDomain(resource.url) ?? "unknown") : null;

  // Fetch cross-page citation quotes and cached content in parallel
  const [quotesData, contentData] = await Promise.all([
    resource.url ? getCitationQuotesByUrl(resource.url) : null,
    resource.url
      ? fetchFromWikiServer<CitationContentData>(
          `/api/citations/content?url=${encodeURIComponent(resource.url)}`,
          { revalidate: 3600 }
        )
      : null,
  ]);

  const quotes = quotesData?.quotes ?? [];
  const stats = quotesData?.stats;

  // Group quotes by page and resolve titles/hrefs server-side
  const quotesByPage = new Map<string, typeof quotes>();
  for (const q of quotes) {
    const pageId = q.pageId;
    if (!quotesByPage.has(pageId)) quotesByPage.set(pageId, []);
    quotesByPage.get(pageId)!.push(q);
  }

  const pageGroups = [...quotesByPage.entries()].map(([pageId, pageQuotes]) => ({
    pageId,
    pageTitle: getPageTitle(pageId),
    pageHref: `/wiki/${pageId}`,
    quotes: pageQuotes.map((q) => ({
      pageId: q.pageId,
      claimText: q.claimText,
      sourceQuote: q.sourceQuote ?? null,
      accuracyVerdict: q.accuracyVerdict ?? null,
      accuracyScore: q.accuracyScore ?? null,
      accuracyIssues: q.accuracyIssues ?? null,
      accuracyCheckedAt: q.accuracyCheckedAt ?? null,
    })),
  }));

  // Determine whether content sections exist
  const hasAbstract = !!resource.abstract;
  const hasSummary = !!resource.summary;
  const hasKeyPoints = resource.key_points && resource.key_points.length > 0;
  const hasReview = !!resource.review;
  const hasContentSections = hasAbstract || hasSummary || hasKeyPoints || hasReview;

  // Build metadata items for a single line
  const metadataItems: string[] = [];
  if (resource.authors && resource.authors.length > 0) {
    metadataItems.push(
      resource.authors.length <= 3
        ? resource.authors.join(", ")
        : `${resource.authors[0]} et al.`
    );
  }
  if (resource.published_date) {
    metadataItems.push(resource.published_date.slice(0, 4));
  }
  if (publication) {
    metadataItems.push(
      publication.name + (publication.peer_reviewed ? " (peer-reviewed)" : "")
    );
  } else if (domain) {
    metadataItems.push(domain);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Back link to Resources index */}
      <Link
        href="/claims/resources"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All Resources
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1.5">
          <h1 className="text-2xl font-bold">{resource.title}</h1>
          {resource.type && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium capitalize">
              <FileText className="w-3 h-3" />
              {resource.type}
            </span>
          )}
        </div>

        {/* Metadata row — authors, year, publication, credibility, and URL on one line */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {metadataItems.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground/30">&middot;</span>}
              <span>{item}</span>
            </span>
          ))}
          {credibility != null && (
            <span className="inline-flex items-center gap-1.5">
              {metadataItems.length > 0 && (
                <span className="text-muted-foreground/30">&middot;</span>
              )}
              <CredibilityBadge
                level={credibility}
                size="sm"
                showLabel
              />
              <span className="text-xs text-muted-foreground/60">
                {publication ? "(publisher rating)" : "(source rating)"}
              </span>
            </span>
          )}
          {resource.url && (() => {
            const shortUrl = resource.url.replace(/^https?:\/\/(www\.)?/, "");
            const displayUrl = shortUrl.length > 60 ? shortUrl.slice(0, 57) + "..." : shortUrl;
            return (
              <span className="inline-flex items-center gap-1.5">
                {(metadataItems.length > 0 || credibility != null) && (
                  <span className="text-muted-foreground/30">&middot;</span>
                )}
                <a
                  href={resource.url}
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

      {/* Data Status Banner — simplified, no content-availability pills */}
      <section className="mb-8 p-4 rounded-lg border border-border bg-card">
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
        <section className="mb-8 rounded-lg border border-border overflow-hidden">
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

      {/* Verification Stats */}
      {stats && stats.totalQuotes > 0 && (
        <section className="mb-8 p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Citation Verification
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold tabular-nums">
                {stats.totalQuotes}
              </div>
              <div className="text-xs text-muted-foreground">
                Claims citing this
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold tabular-nums text-emerald-600">
                {stats.accurate}
              </div>
              <div className="text-xs text-muted-foreground">Accurate</div>
            </div>
            <div>
              <div className="text-2xl font-bold tabular-nums">
                {stats.totalPages}
              </div>
              <div className="text-xs text-muted-foreground">Wiki pages</div>
            </div>
            <div>
              <div className="text-2xl font-bold tabular-nums text-amber-600">
                {stats.inaccurate + stats.unsupported + stats.minorIssues}
              </div>
              <div className="text-xs text-muted-foreground">Flagged</div>
            </div>
          </div>
        </section>
      )}

      {/* Cross-page claims — collapsible, grouped by wiki page */}
      {pageGroups.length > 0 && (
        <CollapsibleClaims
          pageGroups={pageGroups}
          totalClaims={quotes.length}
        />
      )}

      {/* Citing pages — uses EntityLink-style pill links */}
      {citingPages.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <Link2 className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Referenced by {citingPages.length} page
            {citingPages.length !== 1 ? "s" : ""}
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {citingPages.map((pageId) => {
              const entity = getEntityById(pageId);
              const href = getEntityHref(pageId, entity?.type);
              const title = getPageTitle(pageId);
              return (
                <Link
                  key={pageId}
                  href={href}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-sm text-accent-foreground no-underline transition-colors hover:bg-muted/80"
                >
                  {title}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Cached content preview */}
      {contentData?.fullTextPreview && (
        <section className="mb-8">
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
        Resource ID: <code className="px-1 py-0.5 bg-muted rounded">{id}</code>
      </div>
    </div>
  );
}
