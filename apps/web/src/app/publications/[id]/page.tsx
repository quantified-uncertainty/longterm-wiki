import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getPublicationById,
  getResourcesForPublication,
  getPagesForResource,
  getTypedEntityById,
  getPageById,
  getEntityHref,
} from "@/data";
import { getRecordVerdict } from "@/data/tablebase";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { safeHref } from "@/lib/directory-utils";
import {
  PublicationResourcesTable,
  type PublicationResourceRow,
} from "@/app/publications/[id]/publication-resources-table";
import { formatType } from "@/app/publications/publication-utils";
import Link from "next/link";
import {
  Globe,
  FileText,
  BookOpen,
  CheckCircle2,
} from "lucide-react";

// Cache for 1 hour — on-demand rendered to reduce build size.
export const revalidate = 3600;

interface PageProps {
  params: Promise<{ id: string }>;
}

// Render on-demand to reduce build output size (~79 pages saved).

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const pub = getPublicationById(id);
  if (!pub) return { title: "Publication Not Found" };

  return {
    title: `${pub.name} | Publications`,
    description:
      pub.description || `${pub.name} — publication tracked in the wiki.`,
  };
}

const CREDIBILITY_DESCRIPTIONS: Record<number, string> = {
  5: "Gold standard. Rigorous peer review, high editorial standards, and strong institutional reputation.",
  4: "High quality. Established institution or organization with editorial oversight and accountability.",
  3: "Good quality. Reputable source with community review or editorial standards, but less rigorous than peer-reviewed venues.",
  2: "Mixed quality. Some useful content but inconsistent editorial standards. Claims should be verified.",
  1: "Low credibility. Unvetted or unreliable source. Use with caution and always cross-reference.",
};

function getPageTitle(pageId: string): string {
  const entity = getTypedEntityById(pageId);
  if (entity?.title) return entity.title;
  const page = getPageById(pageId);
  if (page?.title) return page.title;
  return pageId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function PublicationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const pub = getPublicationById(id);

  if (!pub) notFound();

  const pubVerdict = getRecordVerdict("publication", pub.id);
  const resources = getResourcesForPublication(pub.id);

  const pageSet = new Set<string>();
  const resourceRows: PublicationResourceRow[] = resources.map((r) => {
    const citingPages = getPagesForResource(r.id);
    for (const pageId of citingPages) {
      pageSet.add(pageId);
    }
    return {
      id: r.id,
      title: r.title,
      type: r.type,
      authors: r.authors ?? [],
      publishedDate: r.published_date ?? null,
      hasSummary: !!r.summary,
      citingPageCount: citingPages.length,
    };
  });

  // Hide the Published column when fewer than 10% of resources have dates
  const datesPopulated = resourceRows.filter((r) => r.publishedDate).length;
  const showPublishedDate =
    resourceRows.length === 0 || datesPopulated / resourceRows.length >= 0.1;

  const titlePills = (
    <>
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-muted">
        {formatType(pub.type)}
      </span>
      {pub.peer_reviewed && (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Peer-reviewed
        </span>
      )}
      <CredibilityBadge level={pub.credibility} size="md" showLabel />
    </>
  );

  const headerLinks = pub.website
    ? [{ label: "Website", href: safeHref(pub.website), external: true }]
    : [];

  const statCards = (
    <div className="grid grid-cols-3 gap-3">
      <ProfileStatCard label="Resources" value={String(resources.length)} />
      <ProfileStatCard label="Citing pages" value={String(pageSet.size)} />
      <ProfileStatCard label="Tracked domains" value={String(pub.domains.length)} />
    </div>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Publications", href: "/publications" },
        { label: pub.name },
      ]}
      title={pub.name}
      titlePills={titlePills}
      verdict={pubVerdict?.verdict ?? null}
      verdictHref={
        pubVerdict?.verdict ? getSourcingHref("publication", pub.id) : undefined
      }
      subtitle={pub.description || undefined}
      headerLinks={headerLinks}
      statCards={statCards}
    >
      <div className="space-y-8">
        <section className="p-4 rounded-lg border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Credibility Rating
          </h2>
          <div className="flex items-start gap-4">
            <div className="shrink-0 text-center">
              <div className="text-3xl font-bold tabular-nums">
                {pub.credibility}/5
              </div>
              <CredibilityBadge
                level={pub.credibility}
                size="md"
                showLabel
                className="mt-1"
              />
            </div>
            <div className="text-sm text-muted-foreground leading-relaxed">
              {pub.credibility_rationale ||
                CREDIBILITY_DESCRIPTIONS[pub.credibility]}
            </div>
          </div>
        </section>

        {pub.domains.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              <Globe className="w-4 h-4 inline mr-1.5 -mt-0.5" />
              Tracked Domains
            </h2>
            <div className="flex flex-wrap gap-2">
              {pub.domains.map((domain) => (
                <span
                  key={domain}
                  className="text-xs px-2.5 py-1 rounded-full border border-border font-mono"
                >
                  {domain}
                </span>
              ))}
            </div>
          </section>
        )}

        {resources.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              <FileText className="w-4 h-4 inline mr-1.5 -mt-0.5" />
              Resources ({resources.length})
            </h2>
            <PublicationResourcesTable resources={resourceRows} showPublishedDate={showPublishedDate} />
          </section>
        )}

        {pageSet.size > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
              Citing Pages ({pageSet.size})
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {[...pageSet].sort().map((pageId) => {
                const href = getEntityHref(pageId);
                const title = getPageTitle(pageId);
                return (
                  <Link
                    key={pageId}
                    href={href}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-sm text-accent-foreground no-underline transition-colors hover:bg-muted/80"
                  >
                    {title}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <div className="text-xs text-muted-foreground border-t border-border pt-4">
          Publication ID:{" "}
          <code className="px-1 py-0.5 bg-muted rounded">{pub.id}</code>
        </div>
      </div>
    </EntityProfileShell>
  );
}
