import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
} from "@data";
import { getCitationQuotesByUrl } from "@/lib/citation-data";
import { fetchFromWikiServer } from "@/lib/wiki-server";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import {
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Clock,
  FileText,
  BookOpen,
  Link2,
} from "lucide-react";
import { cn } from "@lib/utils";

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

const VERDICT_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; label: string; color: string; bg: string }
> = {
  accurate: {
    icon: CheckCircle2,
    label: "Accurate",
    color: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
  minor_issues: {
    icon: AlertTriangle,
    label: "Minor issues",
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
  },
  inaccurate: {
    icon: XCircle,
    label: "Inaccurate",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
  },
  unsupported: {
    icon: XCircle,
    label: "Unsupported",
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
  },
  not_verifiable: {
    icon: HelpCircle,
    label: "Not verifiable",
    color: "text-muted-foreground",
    bg: "bg-muted/30",
  },
};

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

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}


export default async function SourcePage({ params }: PageProps) {
  const { id } = await params;
  const resource = getResourceById(id);

  if (!resource) notFound();

  const publication = getResourcePublication(resource);
  const credibility = getResourceCredibility(resource);
  const citingPages = getPagesForResource(id);
  const domain = resource.url ? getDomain(resource.url) : null;

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

  // Group quotes by page
  const quotesByPage = new Map<string, typeof quotes>();
  for (const q of quotes) {
    const pageId = q.pageId;
    if (!quotesByPage.has(pageId)) quotesByPage.set(pageId, []);
    quotesByPage.get(pageId)!.push(q);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <FileText className="w-3.5 h-3.5" />
          <span>Source</span>
          {resource.type && (
            <>
              <span className="opacity-30">/</span>
              <span className="capitalize">{resource.type}</span>
            </>
          )}
        </div>

        <h1 className="text-2xl font-bold mb-2">{resource.title}</h1>

        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {publication && (
            <span className="italic">
              {publication.name}
              {publication.peer_reviewed && " (peer-reviewed)"}
            </span>
          )}
          {!publication && domain && <span>{domain}</span>}
          {resource.authors && resource.authors.length > 0 && (
            <span>
              {resource.authors.length <= 3
                ? resource.authors.join(", ")
                : `${resource.authors[0]} et al.`}
            </span>
          )}
          {resource.published_date && (
            <span>{resource.published_date.slice(0, 4)}</span>
          )}
          {credibility != null && (
            <CredibilityBadge level={credibility} size="sm" />
          )}
        </div>

        {/* URL */}
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline mt-2"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {resource.url.length > 80
              ? resource.url.slice(0, 77) + "..."
              : resource.url}
          </a>
        )}
      </div>

      {/* Summary */}
      {resource.summary && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Summary
          </h2>
          <p className="text-sm leading-relaxed text-foreground/90">
            {resource.summary}
          </p>
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

      {/* Cross-page claims — grouped by wiki page */}
      {quotesByPage.size > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Claims from Wiki Pages
          </h2>

          {[...quotesByPage.entries()].map(([pageId, pageQuotes]) => (
            <div
              key={pageId}
              className="mb-6 border border-border rounded-lg overflow-hidden"
            >
              <div className="px-4 py-2 bg-muted/50 border-b border-border">
                <a
                  href={`/wiki/${pageId}`}
                  className="text-sm font-medium text-accent-foreground hover:underline"
                >
                  {pageId}
                </a>
                <span className="text-xs text-muted-foreground ml-2">
                  {pageQuotes.length} claim
                  {pageQuotes.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="divide-y divide-border">
                {pageQuotes.map((q, i) => {
                  const verdict = q.accuracyVerdict
                    ? VERDICT_CONFIG[q.accuracyVerdict]
                    : null;
                  const Icon = verdict?.icon;

                  return (
                    <div key={i} className={cn("px-4 py-3", verdict?.bg)}>
                      {/* Claim text */}
                      <p className="text-sm text-foreground leading-relaxed mb-1.5">
                        {q.claimText}
                      </p>

                      {/* Source quote — the key differentiator */}
                      {q.sourceQuote && (
                        <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 mb-2 italic leading-relaxed">
                          &ldquo;{q.sourceQuote}&rdquo;
                        </blockquote>
                      )}

                      {/* Verdict + metadata */}
                      <div className="flex items-center gap-2 text-xs">
                        {verdict && Icon && (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1",
                              verdict.color
                            )}
                          >
                            <Icon className="w-3 h-3" />
                            {verdict.label}
                          </span>
                        )}
                        {q.accuracyScore != null && (
                          <span className="text-muted-foreground tabular-nums">
                            {Math.round(q.accuracyScore * 100)}%
                          </span>
                        )}
                        {q.accuracyIssues && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {q.accuracyIssues}
                          </span>
                        )}
                        {q.accuracyCheckedAt && (
                          <span className="text-muted-foreground/60 ml-auto flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDate(q.accuracyCheckedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Citing pages (from build-time data) */}
      {citingPages.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            <Link2 className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Referenced by {citingPages.length} page
            {citingPages.length !== 1 ? "s" : ""}
          </h2>
          <div className="flex flex-wrap gap-2">
            {citingPages.map((pageId) => (
              <a
                key={pageId}
                href={`/wiki/${pageId}`}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-muted transition-colors"
              >
                {pageId}
              </a>
            ))}
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
                  {"\n\n"}... (truncated, {Math.round(contentData.contentLength! / 1024)} KB total)
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
