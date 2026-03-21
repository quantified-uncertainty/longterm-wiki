import Link from "next/link";
import { BookOpen } from "lucide-react";
import { renderMdxExcerpt, wikiIdToSlug } from "@/lib/mdx";

/**
 * Renders an inline excerpt of the person's wiki page content.
 * Shows the Quick Assessment table and first overview section,
 * with a link to the full wiki article.
 *
 * This is a server component — MDX compilation happens at build/render time.
 */
export async function WikiOverview({
  wikiId,
}: {
  wikiId: string;
}) {
  const slug = wikiIdToSlug(wikiId);
  if (!slug) return null;

  const content = await renderMdxExcerpt(slug);
  if (!content) return null;

  const wikiHref = `/wiki/${wikiId}`;

  return (
    <div className="border border-border/50 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 bg-muted/30 border-b border-border/40">
        <BookOpen className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">
          From wiki article
        </span>
        <Link
          href={wikiHref}
          className="ml-auto text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          Read full article &rarr;
        </Link>
      </div>

      {/* Wiki content excerpt */}
      <div className="px-5 py-4">
        <article className="prose prose-sm max-w-none [&>h2:first-child]:mt-0 [&>h2]:text-lg [&>h2]:font-semibold">
          {content}
        </article>
      </div>

      {/* Footer link */}
      <div className="px-5 py-3 border-t border-border/40 bg-muted/20">
        <Link
          href={wikiHref}
          className="text-sm text-primary hover:text-primary/80 font-medium transition-colors"
        >
          Read full article &rarr;
        </Link>
      </div>
    </div>
  );
}
