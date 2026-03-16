import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, FactValueDisplay } from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";
import { getTypedEntities, getTypedEntityById, isProject, type ProjectEntity } from "@/data";
import { getEntityHref, getWikiHref, getRelatedGraphFor } from "@/data/entity-nav";
import {
  getKBLatest,
  getKBFacts,
  getKBEntity,
  getKBProperty,
} from "@/data/kb";
import { formatKBDate } from "@/components/wiki/kb/format";

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

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
  active:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  maintained:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  beta: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  abandoned:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}

interface RelatedEntity {
  id: string;
  title: string;
  type: string;
  href: string;
  description?: string;
  score: number;
}

function EntityGroup({
  title,
  entities,
}: {
  title: string;
  entities: RelatedEntity[];
}) {
  if (entities.length === 0) return null;
  return (
    <section>
      <SectionHeader title={title} count={entities.length} />
      <div className="border border-border/60 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border/50">
            {entities.map((ent) => (
              <tr key={ent.id} className="hover:bg-muted/20 transition-colors">
                <td className="py-2.5 px-3 min-w-[140px]">
                  <Link
                    href={ent.href}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {ent.title}
                  </Link>
                </td>
                <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[400px]">
                  {ent.description && (
                    <span className="line-clamp-2">{ent.description}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveProjectBySlug(slug);
  if (!entity) return notFound();

  const wikiHref = getWikiHref(entity.id);
  const status = entity.projectStatus ?? entity.status;

  // KB facts
  const websiteFact = getKBLatest(entity.id, "website");
  const foundedDateFact = getKBLatest(entity.id, "founded-date");
  const foundedByFact = getKBLatest(entity.id, "founded-by");
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Resolve website: KB fact takes precedence, then entity fields
  const websiteFromKB =
    websiteFact?.value.type === "text" ? websiteFact.value.value : null;
  const url = websiteFromKB || entity.projectUrl || entity.website;

  // Resolve founded date
  const foundedDateText =
    foundedDateFact?.value.type === "date"
      ? formatKBDate(foundedDateFact.value.value)
      : foundedDateFact?.value.type === "text"
        ? foundedDateFact.value.value
        : entity.startDate ?? null;

  // Resolve organization: founded-by KB fact, then entity field, then relatedEntries
  let orgEntity = null;
  if (foundedByFact?.value.type === "refs" && foundedByFact.value.value.length > 0) {
    const orgRef = foundedByFact.value.value[0];
    orgEntity = getTypedEntityById(orgRef);
  }
  if (!orgEntity) {
    const orgId =
      entity.organization ??
      entity.relatedEntries.find((r) => {
        const e = getTypedEntityById(r.id);
        return e && e.entityType === "organization";
      })?.id;
    orgEntity = orgId ? getTypedEntityById(orgId) : null;
  }

  // Get related entities from the graph and group by type
  const relatedGraph = getRelatedGraphFor(entity.id);
  const organizations: RelatedEntity[] = [];
  const people: RelatedEntity[] = [];
  const projects: RelatedEntity[] = [];

  for (const rel of relatedGraph) {
    const relEntity = getTypedEntityById(rel.id);
    if (!relEntity) continue;
    const item: RelatedEntity = {
      id: rel.id,
      title: rel.title,
      type: rel.type,
      href: rel.href,
      description: relEntity.description,
      score: rel.score,
    };

    switch (relEntity.entityType) {
      case "organization":
        organizations.push(item);
        break;
      case "person":
        people.push(item);
        break;
      case "project":
        projects.push(item);
        break;
    }
  }

  // Also pull in relatedEntries that might not be in the graph
  for (const rel of entity.relatedEntries) {
    const relEntity = getTypedEntityById(rel.id);
    if (!relEntity) continue;
    const alreadyIncluded = relatedGraph.some((g) => g.id === rel.id);
    if (alreadyIncluded) continue;

    const href = getEntityHref(rel.id);
    const item: RelatedEntity = {
      id: rel.id,
      title: relEntity.title,
      type: relEntity.entityType,
      href,
      description: relEntity.description,
      score: 0,
    };

    switch (relEntity.entityType) {
      case "organization":
        organizations.push(item);
        break;
      case "person":
        people.push(item);
        break;
      case "project":
        projects.push(item);
        break;
    }
  }

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
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.title}
          </h1>
          {status && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider capitalize ${
                STATUS_COLORS[status] ??
                "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {status}
            </span>
          )}
        </div>

        {entity.description && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-prose">
            {entity.description}
          </p>
        )}

        {/* Metadata row */}
        <div className="flex items-center gap-4 text-sm flex-wrap">
          {orgEntity && (
            <Link
              href={getEntityHref(orgEntity.id)}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              {orgEntity.title}
            </Link>
          )}
          {foundedDateText && (
            <span className="text-muted-foreground">
              Founded {foundedDateText}
            </span>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              {safeHostname(url)} &#8599;
            </a>
          )}
          {wikiHref && (
            <Link
              href={wikiHref}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki article &rarr;
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
        <div className="space-y-8">
          {/* Organizations */}
          <EntityGroup title="Organizations" entities={organizations} />

          {/* People */}
          <EntityGroup title="People" entities={people} />

          {/* Related Projects */}
          <EntityGroup title="Related Projects" entities={projects} />

          {/* Tech stack */}
          {entity.techStack.length > 0 && (
            <section>
              <SectionHeader title="Tech Stack" />
              <div className="flex flex-wrap gap-2">
                {entity.techStack.map((tech) => (
                  <span
                    key={tech}
                    className="px-3 py-1 rounded-lg border border-border/60 bg-card text-sm font-medium"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </section>
          )}

          <RelatedPages entityId={entity.id} entity={{ type: "project" }} />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* KB Facts */}
          {allFacts.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Key Facts</h3>
              <dl className="space-y-2.5">
                {allFacts.map((fact) => {
                  const prop = getKBProperty(fact.propertyId);
                  return (
                    <div key={fact.id}>
                      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        {prop?.name ?? fact.propertyId}
                      </dt>
                      <dd className="text-sm font-medium">
                        <FactValueDisplay fact={fact} property={prop} />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}

          {entity.clusters.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Clusters</h3>
              <div className="flex flex-wrap gap-1.5">
                {entity.clusters.map((c) => (
                  <span
                    key={c}
                    className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </section>
          )}

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

          <section className="rounded-xl border border-border p-4">
            <h3 className="text-sm font-bold mb-3">Quick Links</h3>
            <div className="flex flex-col gap-2">
              {wikiHref && (
                <Link
                  href={wikiHref}
                  className="text-xs text-primary hover:underline"
                >
                  Wiki article &rarr;
                </Link>
              )}
              <Link
                href={`/kb/entity/${entity.id}`}
                className="text-xs text-primary hover:underline"
              >
                KB data &rarr;
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
