import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";
import {
  getTypedEntities,
  getTypedEntityById,
  isEvent,
  type EventEntity,
} from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

function getEventSlugs(): string[] {
  return getTypedEntities().filter(isEvent).map((e) => e.id);
}

function resolveEventBySlug(slug: string): EventEntity | undefined {
  const entity = getTypedEntityById(slug);
  return entity && isEvent(entity) ? entity : undefined;
}

export function generateStaticParams() {
  return getEventSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveEventBySlug(slug);
  return {
    title: entity ? `${entity.title} | Events` : "Event Not Found",
    description: entity?.description ?? undefined,
  };
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveEventBySlug(slug);
  if (!entity) return notFound();

  const wikiHref = getWikiHref(entity.id);

  // Resolve related entities
  const relatedEntities = entity.relatedEntries
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), type: r.type };
    })
    .filter(Boolean) as Array<{ name: string; href: string; type: string }>;

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Events", href: "/events" },
          { label: entity.title },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-5">
          <div
            className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-500/5 flex items-center justify-center"
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
              className="text-amber-600 dark:text-amber-400"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-tight mb-1">
              {entity.title}
            </h1>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-1">
              {wikiHref && (
                <Link
                  href={wikiHref}
                  className="text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  Wiki article &rarr;
                </Link>
              )}
            </div>
            {entity.description && (
              <p className="text-sm text-muted-foreground leading-relaxed mt-2 max-w-prose">
                {entity.description}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
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

          <RelatedPages entityId={entity.id} entity={{ type: "event" }} />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {entity.sources.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Sources</h3>
              <ul className="space-y-2.5">
                {entity.sources.map((source, i) => (
                  <li key={i} className="text-sm">
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {source.title}
                      </a>
                    ) : (
                      <span>{source.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entity.tags.length > 0 && (
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
          )}
        </div>
      </div>
    </div>
  );
}
