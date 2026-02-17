import { notFound, redirect } from "next/navigation";
import { getInternalPageFrontmatter, getAllInternalSlugs, isMdxError } from "@/lib/mdx";
import { slugToNumericId } from "@/lib/mdx";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

/**
 * Resolve an internal URL slug path to the entity slug used in the ID registry.
 * Internal pages use basename-only slugs (e.g., "ai-research-workflows"),
 * but index pages use special "__index__/..." slugs.
 */
function resolveEntitySlug(slugParts: string[]): string {
  if (slugParts.length === 0) return "__index__/internal";
  // For nested index pages, the catch-all slug is just the directory path
  // We need to check if it matches a directory index
  const basename = slugParts[slugParts.length - 1];

  // Try the basename first (most internal pages use just their filename as slug)
  const numId = slugToNumericId(basename);
  if (numId) return basename;

  // Try __index__ pattern for directory indexes (e.g., ["reports"] → "__index__/internal/reports")
  const indexSlug = `__index__/internal/${slugParts.join("/")}`;
  const indexNumId = slugToNumericId(indexSlug);
  if (indexNumId) return indexSlug;

  return basename;
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
    title: `${title} | Longterm Wiki Internal`,
  };
}

export default async function InternalPage({ params }: PageProps) {
  const { slug } = await params;
  const slugParts = slug || [];

  // Resolve to entity slug and look up numeric ID for redirect
  const entitySlug = resolveEntitySlug(slugParts);
  const numericId = slugToNumericId(entitySlug);

  if (numericId) {
    redirect(`/wiki/${numericId}`);
  }

  // No numeric ID found — check if frontmatter has one directly
  const slugPath = slugParts.join("/");
  const frontmatter = getInternalPageFrontmatter(slugPath);
  if (frontmatter?.numericId) {
    redirect(`/wiki/${frontmatter.numericId}`);
  }

  // Fallback: page has no numeric ID, render not found
  // (React dashboard pages have their own dedicated routes and won't hit this catch-all)
  notFound();
}
