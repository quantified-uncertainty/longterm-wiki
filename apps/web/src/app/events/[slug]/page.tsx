import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { RelatedPages } from "@/components/RelatedPages";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  getTypedEntities,
  getTypedEntityById,
  isEvent,
  type EventEntity,
} from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

function getEventSlugs(): string[] {
  return getTypedEntities().filter(isEvent).filter((e) => !e.deprecated).map((e) => e.id);
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

const CalendarAvatar = (
  <div
    className="w-14 h-14 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-500/5 flex items-center justify-center"
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
);

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveEventBySlug(slug);
  if (!entity) return notFound();

  const wikiHref = entity.wikiId ? getWikiHref(entity.wikiId) : null;

  const relatedEntities = entity.relatedEntries
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), type: r.type };
    })
    .filter(Boolean) as Array<{ name: string; href: string; type: string }>;

  const headerLinks = [
    ...(wikiHref ? [{ label: "Wiki page", href: wikiHref }] : []),
    { label: "Data", href: `/events/${slug}/data` },
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
        { label: "Events", href: "/events" },
        { label: entity.title },
      ]}
      avatar={CalendarAvatar}
      title={entity.title}
      subtitle={entity.description || undefined}
      headerLinks={headerLinks}
      sidebar={sidebar}
    >
      <div className="space-y-8">
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

        <RelatedPages entityId={entity.id} entity={{ entityType: "event" }} />
      </div>
    </EntityProfileShell>
  );
}
