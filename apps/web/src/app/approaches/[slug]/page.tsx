import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { RelatedPages } from "@/components/RelatedPages";
import {
  getTypedEntities,
  getTypedEntityById,
  isApproach,
  getPageById,
  type ApproachEntity,
} from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";

function getApproachSlugs(): string[] {
  return getTypedEntities().filter(isApproach).filter((e) => !e.deprecated).map((e) => e.id);
}

function resolveApproachBySlug(slug: string): ApproachEntity | undefined {
  const entity = getTypedEntityById(slug);
  return entity && isApproach(entity) ? entity : undefined;
}

export function generateStaticParams() {
  return getApproachSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveApproachBySlug(slug);
  return {
    title: entity ? `${entity.title} | Approaches` : "Approach Not Found",
    description: entity?.description ?? undefined,
  };
}

export default async function ApproachDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveApproachBySlug(slug);
  if (!entity) return notFound();

  // If this approach has a wiki article with MDX content, redirect there.
  // The wiki page (/wiki/E*) renders the full article body, including all
  // sections, footnotes, and structured data — the approach directory page
  // only shows sparse entity metadata.
  //
  // We check getPageById to confirm that an MDX page actually exists in the
  // build (avoiding redirecting to /wiki/E* for wikiId-only stubs with no .mdx file).
  if (entity.wikiId && getPageById(entity.id)) {
    permanentRedirect(getWikiHref(entity.wikiId));
  }

  const wikiHref = entity.wikiId ? getWikiHref(entity.wikiId) : null;

  // Resolve related entities
  const relatedEntities = entity.relatedEntries
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), type: r.type };
    })
    .filter(Boolean) as Array<{ name: string; href: string; type: string }>;

  // Sourcing rollup verdict for the header badge
  const sourcingSummary = await fetchEntitySourcingSummary([
    entity.id,
    entity.stableId ?? "",
    slug,
  ]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  const avatar = (
    <div
      className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 flex items-center justify-center"
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-indigo-600 dark:text-indigo-400"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    </div>
  );

  const headerLinks = [
    ...(entity.website
      ? [{ label: "Website", href: entity.website, external: true }]
      : []),
    ...(wikiHref ? [{ label: "Wiki article", href: wikiHref }] : []),
    { label: "Data", href: `/approaches/${slug}/data` },
  ];

  const sidebar = entity.tags.length > 0 ? (
    <section className="rounded-xl border border-border p-4">
      <h3 className="text-sm font-bold mb-3">Tags</h3>
      <div className="flex flex-wrap gap-1.5">
        {entity.tags.map((tag) => (
          <span
            key={tag}
            className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
    </section>
  ) : null;

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Approaches", href: "/approaches" },
        { label: entity.title },
      ]}
      entityId={entity.id}
      avatar={avatar}
      title={entity.title}
      verdict={rollupVerdict}
      subtitle={entity.description || undefined}
      headerLinks={headerLinks}
      sidebar={sidebar}
    >
      <div className="space-y-8">
        {/* Custom fields */}
        {entity.customFields.length > 0 && (
          <section>
            <h2 className="text-lg font-bold mb-4">Details</h2>
            <div className="space-y-3">
              {entity.customFields.map((field) => (
                <div
                  key={field.label}
                  className="px-4 py-3 rounded-lg border border-border/60 bg-card"
                >
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {field.label}
                  </span>
                  <p className="text-sm mt-0.5">{field.value}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Related entities */}
        {relatedEntities.length > 0 && (
          <section>
            <h2 className="text-lg font-bold mb-4">Related</h2>
            <div className="flex flex-wrap gap-2">
              {relatedEntities.map((ref) => (
                <Link
                  key={ref.href}
                  href={ref.href}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-sm transition-colors"
                >
                  <span className="font-medium">{ref.name}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <RelatedPages entityId={entity.id} entity={{ entityType: "approach" }} />
      </div>
    </EntityProfileShell>
  );
}
