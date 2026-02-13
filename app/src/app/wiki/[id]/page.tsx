import { notFound, redirect } from "next/navigation";
import {
  renderMdxPage,
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
  isMdxError,
} from "@/lib/mdx";
import type { MdxPage, MdxError } from "@/lib/mdx";
import { getEntityById, getPageById, getEntityPath } from "@/data";
import type { Page, ContentFormat } from "@/data";
import { CONTENT_FORMAT_INFO } from "@/lib/page-types";
import { PageStatus } from "@/components/PageStatus";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { RelatedPages } from "@/components/RelatedPages";
import { WikiSidebar } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { detectSidebarType, getWikiNav } from "@/lib/wiki-nav";
import { AlertTriangle, Database, Github } from "lucide-react";
import { PageFeedback } from "@/components/wiki/PageFeedback";
import type { Metadata } from "next";
import {
  InfoBoxVisibilityProvider,
  InfoBoxToggle,
} from "@/components/wiki/InfoBoxVisibility";
import { DataInfoBox } from "@/components/wiki/DataInfoBox";
import { LlmWarningBanner } from "@/components/wiki/LlmWarningBanner";

const GITHUB_HISTORY_BASE =
  "https://github.com/quantified-uncertainty/longterm-wiki/commits/main/content/docs";


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
  const title = entity?.title || pageData?.title || slug;
  const description = entity?.description || pageData?.description || undefined;
  const format = (pageData?.contentFormat || "article") as ContentFormat;
  const ogType = format === "article" ? "article" : "website";
  return {
    title,
    description,
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
}: {
  page: MdxPage;
  pageData: Page | undefined;
  slug: string;
  contentFormat: ContentFormat;
}) {
  const lastUpdated = pageData?.lastUpdated;
  const githubUrl = pageData?.filePath
    ? `${GITHUB_HISTORY_BASE}/${pageData.filePath}`
    : null;
  const entity = getEntityById(slug);
  const numId = slugToNumericId(slug);
  const pageTitle = page.frontmatter.title || entity?.title || slug;
  const formatInfo = CONTENT_FORMAT_INFO[contentFormat];

  return (
    <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
      <Breadcrumbs
        category={pageData?.category}
        title={page.frontmatter.title || entity?.title}
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
        <PageFeedback pageTitle={pageTitle} pageSlug={slug} />
        <InfoBoxToggle />
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

function ContentView({
  page,
  pageData,
  entityPath,
  slug,
  fullWidth,
}: {
  page: MdxPage;
  pageData: Page | undefined;
  entityPath: string;
  slug: string;
  fullWidth?: boolean;
}) {
  const entity = getEntityById(slug);
  const contentFormat = (pageData?.contentFormat || "article") as ContentFormat;
  const formatInfo = CONTENT_FORMAT_INFO[contentFormat];
  const isArticle = contentFormat === "article";

  return (
    <InfoBoxVisibilityProvider>
      <JsonLd pageData={pageData} title={page.frontmatter.title} slug={slug} />
      <ContentMeta
        page={page}
        pageData={pageData}
        slug={slug}
        contentFormat={contentFormat}
      />
      <LlmWarningBanner />
      <article className={`prose min-w-0${fullWidth ? " prose-full-width" : ""}`}>
        {/* PageStatus shown for graded formats or pages with editorial content */}
        <PageStatus
          quality={pageData?.quality ?? undefined}
          importance={pageData?.importance ?? undefined}
          llmSummary={pageData?.llmSummary ?? undefined}
          structuredSummary={pageData?.structuredSummary ?? undefined}
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
        />
        {page.frontmatter.title && <h1>{page.frontmatter.title}</h1>}
        {isArticle && entity && <DataInfoBox entityId={slug} />}
        {page.content}
      </article>
      {/* Related pages rendered outside prose to avoid inherited link styles */}
      {isArticle && <RelatedPages entityId={slug} entity={entity} />}
    </InfoBoxVisibilityProvider>
  );
}

function WithSidebar({
  entityPath,
  fullWidth,
  children,
}: {
  entityPath: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  const sidebarType = detectSidebarType(entityPath);

  // Compute content container class once:
  // - fullWidth: edge-to-edge (for table pages)
  // - with sidebar: narrower max to leave room for sidebar
  // - no sidebar: wider max for standalone articles
  const contentClass = fullWidth
    ? "w-full px-3 py-4"
    : sidebarType
      ? "max-w-[65rem] mx-auto px-8 py-4"
      : "max-w-7xl mx-auto px-6 py-8";

  if (!sidebarType) {
    return <div className={contentClass}>{children}</div>;
  }

  const sections = getWikiNav(sidebarType);
  return (
    <SidebarProvider>
      <WikiSidebar sections={sections} />
      <div className="flex-1 min-w-0">
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

    const result = await renderMdxPage(slug);
    if (!result) notFound();
    if (isMdxError(result)) return <MdxErrorView error={result} />;

    const entityPath = getEntityPath(slug) || "";
    const pageData = getPageById(slug);
    const formatInfo = CONTENT_FORMAT_INFO[(pageData?.contentFormat || "article") as ContentFormat];
    const fullWidth = result.frontmatter.fullWidth === true || formatInfo?.fullWidth === true;
    return (
      <WithSidebar entityPath={entityPath} fullWidth={fullWidth}>
        <ContentView
          page={result}
          pageData={pageData}
          entityPath={entityPath}
          slug={slug}
          fullWidth={fullWidth}
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
    const result = await renderMdxPage(id);
    if (!result) notFound();
    if (isMdxError(result)) return <MdxErrorView error={result} />;

    const entityPath = getEntityPath(id) || "";
    const pageData = getPageById(id);
    const formatInfo = CONTENT_FORMAT_INFO[(pageData?.contentFormat || "article") as ContentFormat];
    const fullWidth = result.frontmatter.fullWidth === true || formatInfo?.fullWidth === true;
    return (
      <WithSidebar entityPath={entityPath} fullWidth={fullWidth}>
        <ContentView
          page={result}
          pageData={pageData}
          entityPath={entityPath}
          slug={id}
          fullWidth={fullWidth}
        />
      </WithSidebar>
    );
  }
}
