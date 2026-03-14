import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";
import { getTypedEntities, getTypedEntityById } from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

type EventLikeEntity = {
  id: string;
  title: string;
  entityType: string;
  description?: string;
  numericId?: string;
  tags: string[];
  sources: Array<{ title: string; url?: string; author?: string; date?: string }>;
  relatedEntries: Array<{ id: string; type: string; relationship?: string }>;
  eventDate?: string;
  endDate?: string;
  location?: string;
  eventType?: string;
  significance?: string;
};

function getEventEntities(): EventLikeEntity[] {
  return getTypedEntities().filter(
    (e) => e.entityType === "event" || e.entityType === "historical",
  ) as EventLikeEntity[];
}

function resolveEventBySlug(slug: string): EventLikeEntity | undefined {
  const entity = getTypedEntityById(slug);
  if (!entity || (entity.entityType !== "event" && entity.entityType !== "historical")) return undefined;
  return entity as EventLikeEntity;
}

export function generateStaticParams() {
  return getEventEntities().map((e) => ({ slug: e.id }));
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

const TYPE_COLORS: Record<string, string> = {
  summit: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  incident: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  announcement: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  milestone: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

const SIGNIFICANCE_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  medium: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  low: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveEventBySlug(slug);
  if (!entity) return notFound();

  const wikiHref = entity.numericId ? getWikiHref(entity.id) : null;
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

      <div className="mb-8">
        <div className="flex items-start gap-5">
          <div className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-500/5 flex items-center justify-center" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 dark:text-amber-400">
              <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
              <line x1="16" x2="16" y1="2" y2="6" />
              <line x1="8" x2="8" y1="2" y2="6" />
              <line x1="3" x2="21" y1="10" y2="10" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight">{entity.title}</h1>
              {entity.eventType && (
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider capitalize ${TYPE_COLORS[entity.eventType] ?? "bg-gray-100 text-gray-600"}`}>
                  {entity.eventType}
                </span>
              )}
              {entity.significance && (
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider capitalize ${SIGNIFICANCE_COLORS[entity.significance] ?? "bg-gray-100 text-gray-600"}`}>
                  {entity.significance}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-1">
              {entity.eventDate && <span className="font-medium">{entity.eventDate}{entity.endDate ? ` — ${entity.endDate}` : ""}</span>}
              {entity.location && <span>{entity.location}</span>}
              {wikiHref && (
                <Link href={wikiHref} className="text-primary hover:text-primary/80 font-medium transition-colors">
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
          {relatedEntities.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Related</h2>
              <div className="flex flex-wrap gap-2">
                {relatedEntities.map((ref) => (
                  <Link key={ref.href} href={ref.href} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-sm transition-colors">
                    <span className="font-medium">{ref.name}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          <RelatedPages entityId={entity.id} entity={{ type: entity.entityType }} />
        </div>

        <div className="space-y-6">
          {entity.sources.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Sources</h3>
              <ul className="space-y-2.5">
                {entity.sources.map((source, i) => (
                  <li key={i} className="text-sm">
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{source.title}</a>
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
                  <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">{tag}</span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
