import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";

function safeHostname(url: string): string {
  try { return new URL(url).hostname.replace("www.", ""); }
  catch { return url; }
}
import { getTypedEntities, getTypedEntityById, isProject, type ProjectEntity } from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

function getProjectSlugs(): string[] {
  return getTypedEntities().filter(isProject).map((e) => e.id);
}

function resolveProjectBySlug(slug: string): ProjectEntity | undefined {
  const entity = getTypedEntityById(slug);
  return entity && isProject(entity) ? entity : undefined;
}

export function generateStaticParams() {
  return getProjectSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveProjectBySlug(slug);
  return {
    title: entity ? `${entity.title} | Projects` : "Project Not Found",
    description: entity?.description ?? undefined,
  };
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  maintained: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  beta: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  abandoned: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveProjectBySlug(slug);
  if (!entity) return notFound();

  const url = entity.projectUrl || entity.website;
  const wikiHref = getWikiHref(entity.id);

  // Resolve related entities
  const relatedEntities = entity.relatedEntries
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), type: r.type };
    })
    .filter(Boolean) as Array<{ name: string; href: string; type: string }>;

  // Resolve org
  const orgEntity = entity.organization ? getTypedEntityById(entity.organization) : null;

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: entity.title },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-5">
          <div className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-teal-500/20 to-teal-500/5 flex items-center justify-center" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-teal-600 dark:text-teal-400">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight">{entity.title}</h1>
              {entity.projectStatus && (
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider capitalize ${STATUS_COLORS[entity.projectStatus] ?? "bg-gray-100 text-gray-600"}`}>
                  {entity.projectStatus}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-1">
              {orgEntity && (
                <Link href={getEntityHref(orgEntity.id)} className="text-primary hover:underline">
                  {orgEntity.title}
                </Link>
              )}
              {entity.startDate && <span>Started {entity.startDate}</span>}
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 font-medium transition-colors">
                  {safeHostname(url)} &#8599;
                </a>
              )}
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
          {/* Tech stack */}
          {entity.techStack.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Tech Stack</h2>
              <div className="flex flex-wrap gap-2">
                {entity.techStack.map((tech) => (
                  <span key={tech} className="px-3 py-1 rounded-lg border border-border/60 bg-card text-sm font-medium">
                    {tech}
                  </span>
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
                  <Link key={ref.href} href={ref.href} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-sm transition-colors">
                    <span className="font-medium">{ref.name}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <RelatedPages entityId={entity.id} entity={{ type: "project" }} />
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
