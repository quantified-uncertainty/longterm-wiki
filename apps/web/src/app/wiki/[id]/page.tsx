import { notFound, redirect } from "next/navigation";
import {
  renderMdxPage,
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
  isMdxError,
} from "@/lib/mdx";
import type { MdxPage, MdxError } from "@/lib/mdx";
import { getEntityById, getPageById, getEntityPath, getResourcesForPage, getFactsForEntityWithFallback } from "@/data";
import type { Page, ContentFormat } from "@/data";
import { CONTENT_FORMAT_INFO, isFullWidth } from "@/lib/page-types";
import { PageStatus } from "@/components/PageStatus";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { RelatedPages } from "@/components/RelatedPages";
import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { detectSidebarType, getWikiNav, isAboutPage } from "@/lib/wiki-nav";
import { AlertTriangle, Database, Github, FileCheck, BarChart3 } from "lucide-react";
import { PageFeedback } from "@/components/wiki/PageFeedback";
import type { Metadata } from "next";
import {
  InfoBoxVisibilityProvider,
  InfoBoxToggle,
} from "@/components/wiki/InfoBoxVisibility";
import { DataInfoBox } from "@/components/wiki/DataInfoBox";
import { ContentConfidenceBanner } from "@/components/wiki/ContentConfidenceBanner";
import { TableOfContents } from "@/components/wiki/TableOfContents";
import { CitationOverlay } from "@/components/wiki/CitationOverlay";
import { CitationHealthBanner } from "@/components/wiki/CitationHealthBanner";
import { CitationQuotesProvider } from "@/components/wiki/CitationQuotesContext";
import { ReferenceProvider } from "@/components/wiki/ReferenceContext";
import type { RefMapEntry } from "@/components/wiki/ReferenceContext";
import type { RefMapEntry as PreprocessorRefMapEntry } from "@/lib/reference-preprocessor";
import { References } from "@/components/wiki/References";
import { getCitationQuotes, computeCitationHealth } from "@/lib/citation-data";
import type { CitationQuote } from "@/lib/citation-data";
import { EntityStatementsCard } from "@/components/wiki/EntityStatementsCard";
import { PageStatementsSection } from "@/components/wiki/PageStatementsSection";

import { GITHUB_REPO_URL } from "@lib/site-config";

/**
 * Build a reference map from citation quotes and footnote index data.
 * Maps footnote numbers to rich reference data for the FootnoteTooltip component.
 */
function buildReferenceMap(
  citationQuotes: CitationQuote[] | undefined,
  slug: string,
  preprocessorMap?: Map<number, PreprocessorRefMapEntry>,
): Map<number, RefMapEntry> {
  const map = new Map<number, RefMapEntry>();

  // Start with preprocessor entries (from DB-driven [^cr-XXXX] / [^rc-XXXX])
  if (preprocessorMap) {
    for (const [num, entry] of preprocessorMap) {
      if (entry.kind === "claim" && entry.data) {
        const d = entry.data as { claimId: number; claimText: string; sourceUrl?: string; sourceTitle?: string; verdict?: string; verdictScore?: number };
        map.set(num, {
          type: "claim",
          claimText: d.claimText,
          sourceUrl: d.sourceUrl ?? null,
          sourceTitle: d.sourceTitle ?? null,
        });
      } else if (entry.kind === "citation" && entry.data) {
        const d = entry.data as { title?: string; url?: string; note?: string };
        map.set(num, {
          type: "citation",
          title: d.title ?? null,
          url: d.url ?? null,
          domain: d.url ? new URL(d.url).hostname.replace(/^www\./, "") : null,
          note: d.note ?? null,
        });
      }
    }
  }

  // Layer citation quotes on top (they have richer verification data)
  if (citationQuotes) {
    for (const q of citationQuotes) {
      map.set(q.footnote, {
        type: "claim",
        claimText: q.claimText,
        verdict: q.accuracyVerdict,
        verdictScore: q.accuracyScore,
        quoteVerified: q.quoteVerified,
        sourceUrl: q.url,
        sourceTitle: q.sourceTitle,
        sourceQuote: q.sourceQuote,
        accuracyIssues: q.accuracyIssues,
        checkedAt: q.accuracyCheckedAt,
        resourceId: q.resourceId,
      });
    }
  }

  return map;
}

const GITHUB_HISTORY_BASE = `${GITHUB_REPO_URL}/commits/main/content/docs`;


interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;

  let slug: string | null;
  if (isNumericId(id)) {
    slug = numericIdToSlug(id.toUpperCase());
  } else {
    slug = id;
  }

  if (!slug) return { title: "Not Found" };

  const entity = getEntityById(slug);
  const pageData = getPageById(slug);
  const entityPath = getEntityPath(slug);
  const isInternal = entityPath?.startsWith("/internal");
  const isAbout = entityPath ? isAboutPage(entityPath) : false;
  const title = entity?.title || pageData?.title || slug;
  const description = entity?.description || pageData?.description || undefined;
  const format = (pageData?.contentFormat || "article") as ContentFormat;
  const ogType = format === "article" ? "article" : "website";
  return {
    title,
    description,
    // Internal pages (but not About pages) should not be indexed by search engines
    ...(isInternal && !isAbout && { robots: { index: false, follow: false } }),
    openGraph: {
      title,
      description,
      type: ogType,
      ...(pageData?.lastUpdated && { modifiedTime: pageData.lastUpdated }),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/** Map contentFormat to schema.org @type */
function schemaType(format: ContentFormat): string {
  switch (format) {
    case "table": return "Dataset";
    case "diagram": return "ImageObject";
    case "index": return "CollectionPage";
    case "dashboard": return "WebPage";
    default: return "Article";
  }
}

function JsonLd({ pageData, title, slug }: { pageData?: Page; title?: string; slug: string }) {
  const headline = title || pageData?.title || slug;
  const format = (pageData?.contentFormat || "article") as ContentFormat;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": schemaType(format),
    headline,
    ...(pageData?.description && { description: pageData.description }),
    ...(pageData?.llmSummary && { abstract: pageData.llmSummary }),
    ...(pageData?.lastUpdated && { dateModified: pageData.lastUpdated }),
    isPartOf: {
      "@type": "WebSite",
      name: "Longterm Wiki",
    },
  };

  // Escape </script> and HTML entities to prevent XSS via dangerouslySetInnerHTML
  const safeJson = JSON.stringify(jsonLd)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  );
}

/** Shared metadata bar rendered above all content formats */
function ContentMeta({
  page,
  pageData,
  slug,
  contentFormat,
  isInternal,
  isAbout,
}: {
  page: MdxPage;
  pageData: Page | undefined;
  slug: string;
  contentFormat: ContentFormat;
  isInternal?: boolean;
  isAbout?: boolean;
}) {
  const lastUpdated = pageData?.lastUpdated;
  const githubUrl = pageData?.filePath
    ? `${GITHUB_HISTORY_BASE}/${pageData.filePath}`
    : null;
  const entity = getEntityById(slug);
  const numId = slugToNumericId(slug);
  const pageTitle = page.frontmatter.title || entity?.title || slug;

  return (
    <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
      <Breadcrumbs
        category={pageData?.category}
        title={page.frontmatter.title || entity?.title}
        isInternal={isInternal}
        isAbout={isAbout}
      />
      <div className="page-meta">
        {lastUpdated && (
          <span className="page-meta-updated">
            Updated {lastUpdated}
          </span>
        )}
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="page-meta-github"
          >
            <Github size={14} />
            History
          </a>
        )}
        {numId && (
          <a href={`/wiki/${numId}/data`} className="page-meta-github">
            <Database size={14} />
            Data
          </a>
        )}
        {numId && (
          <a href={`/wiki/${numId}/statements`} className="page-meta-github">
            <BarChart3 size={14} />
            Statements
          </a>
        )}
        {numId && (
          <a href={`/claims/entity/${slug}`} className="page-meta-github">
            <FileCheck size={14} />
            Claims
          </a>
        )}
        <PageFeedback pageTitle={pageTitle} pageSlug={slug} />
        {!isInternal && <InfoBoxToggle />}
      </div>
    </div>
  );
}

function MdxErrorView({ error }: { error: MdxError }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-start gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-semibold mb-1">Content compilation error</h2>
          <p className="text-sm text-muted-foreground mb-3">
            The MDX content for <code className="text-xs px-1.5 py-0.5 bg-muted rounded">{error.slug}</code> failed to compile.
          </p>
          <pre className="text-xs bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap break-words max-h-60">
            {error.error}
          </pre>
          <p className="text-xs text-muted-foreground mt-3">
            File: <code className="px-1 py-0.5 bg-muted rounded">{error.filePath}</code>
          </p>
        </div>
      </div>
    </div>
  );
}

async function ContentView({
  page,
  pageData,
  entityPath,
  slug,
  fullWidth,
  hideSidebar,
  citationQuotes,
}: {
  page: MdxPage;
  pageData: Page | undefined;
  entityPath: string;
  slug: string;
  fullWidth?: boolean;
  hideSidebar?: boolean;
  citationQuotes?: import("@/lib/citation-data").CitationQuote[];
}) {
  const entity = getEntityById(slug);
  const contentFormat = (pageData?.contentFormat || "article") as ContentFormat;
  const formatInfo = CONTENT_FORMAT_INFO[contentFormat];
  const isArticle = contentFormat === "article";
  const isInternal = entityPath.startsWith("/internal");
  const isAbout = isAboutPage(entityPath);

  // Show TOC for non-internal articles with enough words and headings.
  // Opt-out via frontmatter: toc: false
  const wordCount = pageData?.wordCount ?? 0;
  const tocHeadings = page.headings.filter((h) => h.depth <= 3);
  const showToc =
    isArticle &&
    !isInternal &&
    page.frontmatter.toc !== false &&
    wordCount > 1500 &&
    tocHeadings.length >= 3;

  const factCount = entity
    ? Object.keys((await getFactsForEntityWithFallback(slug)).data).length
    : undefined;

  // Compute citation health from live quotes (not stale build-time data)
  const liveCitationHealth = citationQuotes && citationQuotes.length > 0
    ? (() => {
        const h = computeCitationHealth(citationQuotes);
        return {
          total: h.total,
          withQuotes: h.total - h.unchecked,
          verified: h.verified + h.accurate + h.inaccurate + h.unsupported + h.minorIssues,
          accuracyChecked: h.accurate + h.inaccurate + h.unsupported + h.minorIssues,
          accurate: h.accurate,
          inaccurate: h.inaccurate,
          avgScore: null as number | null,
        };
      })()
    : pageData?.citationHealth ?? undefined;

  return (
    <InfoBoxVisibilityProvider>
      {!isInternal && <JsonLd pageData={pageData} title={page.frontmatter.title} slug={slug} />}
      <ContentMeta
        page={page}
        pageData={pageData}
        slug={slug}
        contentFormat={contentFormat}
        isInternal={isInternal}
        isAbout={isAbout}
      />
      {!isInternal && (
        <ContentConfidenceBanner
          hallucinationRisk={pageData?.hallucinationRisk}
        />
      )}
      {!isInternal && citationQuotes && citationQuotes.length > 0 && (
        <CitationHealthBanner health={computeCitationHealth(citationQuotes)} />
      )}
      {/* PageStatus rendered above article so it spans full width (not squeezed by info box) */}
      <PageStatus
        quality={pageData?.quality ?? undefined}
        importance={pageData?.readerImportance ?? undefined}
        researchImportance={pageData?.researchImportance ?? undefined}
        llmSummary={pageData?.llmSummary ?? undefined}
        lastEdited={pageData?.lastUpdated ?? undefined}
        updateFrequency={pageData?.updateFrequency ?? undefined}
        evergreen={pageData?.evergreen}
        todo={page.frontmatter.todo}
        todos={page.frontmatter.todos}
        wordCount={pageData?.wordCount}
        backlinkCount={pageData?.backlinkCount}
        metrics={pageData?.metrics}
        suggestedQuality={pageData?.suggestedQuality}
        changeHistory={pageData?.changeHistory}
        issues={{
          unconvertedLinkCount: pageData?.unconvertedLinkCount,
          redundancy: pageData?.redundancy,
        }}
        pageType={page.frontmatter.pageType}
        pathname={entityPath}
        contentFormat={contentFormat}
        hasEntity={!!entity}
        entityType={pageData?.entityType ?? undefined}
        resourceCount={getResourcesForPage(slug).length}
        citationHealth={liveCitationHealth}
        ratings={pageData?.ratings ?? undefined}
        factCount={factCount}
        coverage={pageData?.coverage}
      />
      <CitationQuotesProvider quotes={citationQuotes ?? []}>
        <ReferenceProvider referenceMap={buildReferenceMap(citationQuotes, slug, page.referenceMap)}>
        <article className={`prose min-w-0${fullWidth ? " prose-full-width" : ""}${hideSidebar && fullWidth ? " prose-constrain-text" : ""}`}>
          {page.frontmatter.title && <h1>{page.frontmatter.title}</h1>}
          {isArticle && !isInternal && entity && <DataInfoBox entityId={slug} />}
          {showToc && <TableOfContents headings={tocHeadings} />}
          {page.content}
          {isArticle && !isInternal && entity && (
            <PageStatementsSection entityId={slug} />
          )}
          {!isInternal && <References pageId={slug} />}
        </article>
        </ReferenceProvider>
        {citationQuotes && citationQuotes.length > 0 && (
          <CitationOverlay quotes={citationQuotes} />
        )}
      </CitationQuotesProvider>
      {/* Related pages rendered outside prose to avoid inherited link styles */}
      {isArticle && !isInternal && <RelatedPages entityId={slug} entity={entity} />}
    </InfoBoxVisibilityProvider>
  );
}

function WithSidebar({
  entityPath,
  fullWidth,
  hideSidebar,
  children,
}: {
  entityPath: string;
  fullWidth?: boolean;
  hideSidebar?: boolean;
  children: React.ReactNode;
}) {
  const sidebarType = detectSidebarType(entityPath);
  const sections = sidebarType && !hideSidebar ? getWikiNav(sidebarType, entityPath) : [];
  const hasSidebar = sections.length > 0;

  // Compute content container class:
  // - hideSidebar + fullWidth: wide centered layout, no sidebar
  // - fullWidth alone: edge-to-edge (for table pages with sidebar)
  // - with sidebar: narrower max to leave room for sidebar
  // - no sidebar: wider max for standalone articles
  const contentClass = hideSidebar && fullWidth
    ? "max-w-[90rem] mx-auto px-8 py-6"
    : fullWidth
      ? "w-full px-3 py-4"
      : hasSidebar
        ? "max-w-[65rem] mx-auto px-8 py-4"
        : "max-w-7xl mx-auto px-6 py-8";

  if (!sections.length) {
    return <div className={contentClass}>{children}</div>;
  }

  return (
    <SidebarProvider>
      <WikiSidebar sections={sections} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className={contentClass}>{children}</div>
      </div>
    </SidebarProvider>
  );
}

export default async function WikiPage({ params }: PageProps) {
  const { id } = await params;

  if (isNumericId(id)) {
    // Numeric ID like E42 — look up slug and render
    const slug = numericIdToSlug(id.toUpperCase());
    if (!slug) notFound();

    const entityPath = getEntityPath(slug) || "";

    const [result, citationQuotes] = await Promise.all([
      renderMdxPage(slug),
      getCitationQuotes(slug),
    ]);
    if (!result) notFound();
    if (isMdxError(result)) return <MdxErrorView error={result} />;

    const pageData = getPageById(slug);
    const contentFormat = (pageData?.contentFormat || "article") as ContentFormat;
    const fullWidth = isFullWidth(contentFormat, result.frontmatter);
    const hideSidebar = result.frontmatter.hideSidebar === true;
    return (
      <WithSidebar entityPath={entityPath} fullWidth={fullWidth} hideSidebar={hideSidebar}>
        <ContentView
          page={result}
          pageData={pageData}
          entityPath={entityPath}
          slug={slug}
          fullWidth={fullWidth}
          hideSidebar={hideSidebar}
          citationQuotes={citationQuotes}
        />
      </WithSidebar>
    );
  } else {
    // String slug like "geoffrey-hinton"
    // If it has a numeric ID, redirect to canonical URL
    const numericId = slugToNumericId(id);
    if (numericId) {
      redirect(`/wiki/${numericId}`);
    }

    // No numeric ID — render directly by slug (page-only content without entity)
    const entityPath = getEntityPath(id) || "";

    const [result, citationQuotes] = await Promise.all([
      renderMdxPage(id),
      getCitationQuotes(id),
    ]);
    if (!result) notFound();
    if (isMdxError(result)) return <MdxErrorView error={result} />;

    const pageData = getPageById(id);
    const contentFormat = (pageData?.contentFormat || "article") as ContentFormat;
    const fullWidth = isFullWidth(contentFormat, result.frontmatter);
    const hideSidebar = result.frontmatter.hideSidebar === true;
    return (
      <WithSidebar entityPath={entityPath} fullWidth={fullWidth} hideSidebar={hideSidebar}>
        <ContentView
          page={result}
          pageData={pageData}
          entityPath={entityPath}
          slug={id}
          fullWidth={fullWidth}
          hideSidebar={hideSidebar}
          citationQuotes={citationQuotes}
        />
      </WithSidebar>
    );
  }
}
