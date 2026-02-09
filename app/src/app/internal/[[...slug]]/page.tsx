import { notFound } from "next/navigation";
import { renderInternalPage, getAllInternalSlugs, getInternalPageFrontmatter, isMdxError } from "@/lib/mdx";
import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export async function generateStaticParams() {
  const slugs = getAllInternalSlugs();
  return [{ slug: undefined }, ...slugs.map((slug) => ({ slug }))];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const slugPath = slug ? slug.join("/") : "";
  const frontmatter = getInternalPageFrontmatter(slugPath);
  const title = frontmatter?.title || "Internal";
  return {
    title: `${title} | Cairn Internal`,
  };
}

export default async function InternalPage({ params }: PageProps) {
  const { slug } = await params;
  const slugPath = slug ? slug.join("/") : "";

  const result = await renderInternalPage(slugPath);
  if (!result) {
    notFound();
  }

  if (isMdxError(result)) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-start gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold mb-1">Content compilation error</h2>
            <p className="text-sm text-muted-foreground mb-3">
              The MDX content for <code className="text-xs px-1.5 py-0.5 bg-muted rounded">{result.slug}</code> failed to compile.
            </p>
            <pre className="text-xs bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap break-words max-h-60">
              {result.error}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
    <article className="prose max-w-none">
      {result.frontmatter.title && <h1>{result.frontmatter.title}</h1>}
      {result.content}
    </article>
    </div>
  );
}
