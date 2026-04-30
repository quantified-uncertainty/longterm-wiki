import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getResearchAreasFromPG, getTypedEntityById, getResearchAreaDetail } from "@/data/tablebase";
import { getEntityHref } from "@/data/entity-nav";
import {
  CLUSTER_COLORS,
  STATUS_COLORS,
  formatCluster,
  formatFunding,
} from "../research-area-constants";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function getAreaBySlug(slug: string) {
  // Include empty areas so detail pages work for all research areas
  return getResearchAreasFromPG({ includeEmpty: true }).find((a) => a.id === slug) ?? null;
}

function getAllSlugs(): string[] {
  // Include empty areas so generateStaticParams covers all research areas
  return getResearchAreasFromPG({ includeEmpty: true }).map((a) => a.id);
}

function resolveEntityName(id: string): string {
  const entity = getTypedEntityById(id);
  return entity?.title ?? id;
}

function resolveEntityLink(id: string): { name: string; href: string | null } {
  const entity = getTypedEntityById(id);
  return {
    name: entity?.title ?? id,
    href: entity ? getEntityHref(id) : null,
  };
}

// ---------------------------------------------------------------------------
// Static generation
// ---------------------------------------------------------------------------

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const area = getAreaBySlug(slug);
  return {
    title: area ? `${area.title} | Research Areas` : "Research Area Not Found",
    description: area?.description ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function ResearchAreaDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const area = getAreaBySlug(slug);
  if (!area) return notFound();

  // Find child areas from build-time data (include empty for complete hierarchy)
  const allAreas = getResearchAreasFromPG({ includeEmpty: true });
  const children = allAreas.filter((a) => a.parentAreaId === area.id);
  const parent = area.parentAreaId
    ? allAreas.find((a) => a.id === area.parentAreaId)
    : null;

  // Load detail data from build-time JSON (fetched from wiki-server during build-data)
  const detail = getResearchAreaDetail(slug);

  const grants = detail?.grants ?? [];
  const fundingByOrg = detail?.fundingByOrg ?? [];
  const papers = detail?.papers ?? [];
  const organizations = detail?.organizations ?? [];

  const stats = [
    { label: "Organizations", value: String(area.orgCount) },
    { label: "Key Papers", value: String(area.paperCount) },
    { label: "Grants", value: String(area.grantCount) },
    { label: "Total Funding", value: formatFunding(area.totalFunding) },
    { label: "Risks Addressed", value: String(area.riskCount) },
  ].filter((s) => s.value !== "0" && s.value !== "-");

  // Sourcing rollup verdict
  const sourcingSummary = await fetchEntitySourcingSummary([area.id, slug]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  const breadcrumbs: Array<{ label: string; href?: string }> = [
    { label: "Research Areas", href: "/research-areas" },
  ];
  if (parent) {
    breadcrumbs.push({
      label: parent.title,
      href: `/research-areas/${parent.id}`,
    });
  }
  breadcrumbs.push({ label: area.title });

  const titlePills = (
    <>
      {area.cluster && (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            CLUSTER_COLORS[area.cluster] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {formatCluster(area.cluster)}
        </span>
      )}
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          STATUS_COLORS[area.status] ?? ""
        }`}
      >
        {area.status}
      </span>
    </>
  );

  const headerLinks = [
    ...(area.wikiId
      ? [{ label: "Wiki page", href: `/wiki/${area.wikiId}` }]
      : []),
    { label: "Data", href: `/research-areas/${slug}/data` },
  ];

  const statCards = stats.length > 0 && (
    <div
      className={`grid grid-cols-2 gap-3 ${stats.length >= 4 ? "sm:grid-cols-4" : stats.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
    >
      {stats.map((stat) => (
        <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
      ))}
    </div>
  );

  const sidebar = area.tags.length > 0 ? (
    <section className="rounded-xl border border-border p-4">
      <h3 className="text-sm font-bold mb-3">Tags</h3>
      <div className="flex flex-wrap gap-1.5">
        {area.tags.map((tag) => (
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
      breadcrumbs={breadcrumbs}
      entityId={area.id}
      title={area.title}
      titlePills={titlePills}
      verdict={rollupVerdict}
      subtitle={area.description || undefined}
      headerLinks={headerLinks}
      statCards={statCards}
      sidebar={sidebar}
    >
      <div className="space-y-8">
        {/* Details */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          {area.firstProposed && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">First Proposed: </span>
              <span className="font-medium">{area.firstProposed}</span>
            </div>
          )}
          {area.cluster && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">Cluster: </span>
              <span className="font-medium">{formatCluster(area.cluster)}</span>
            </div>
          )}
          {parent && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">Parent Area: </span>
              <Link
                href={`/research-areas/${parent.id}`}
                className="font-medium text-primary hover:text-primary/80"
              >
                {parent.title}
              </Link>
            </div>
          )}
        </div>

        {/* Organizations */}
        {organizations.length > 0 && (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Organizations
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {organizations.length}
              </span>
            </h2>
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3 text-left font-medium">
                      Organization
                    </th>
                    <th className="py-2.5 px-3 text-left font-medium">Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {organizations.map((org) => {
                    const resolved = resolveEntityLink(org.organizationId);
                    return (
                      <tr
                        key={org.organizationId}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <td className="py-2.5 px-3">
                          {resolved.href ? (
                            <Link
                              href={resolved.href}
                              className="font-medium hover:text-primary transition-colors"
                            >
                              {resolved.name}
                            </Link>
                          ) : (
                            <span className="font-medium">{resolved.name}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground capitalize">
                          {org.role}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Grants */}
        {grants.length > 0 && (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Grants
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {area.grantCount > grants.length
                  ? `Top ${grants.length} of ${area.grantCount}`
                  : grants.length}
              </span>
            </h2>
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3 text-left font-medium">Name</th>
                    <th className="py-2.5 px-3 text-left font-medium">
                      Recipient
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Amount
                    </th>
                    <th className="py-2.5 px-3 text-left font-medium">Funder</th>
                    <th className="py-2.5 px-3 text-left font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {grants.map((grant) => {
                    const funder = resolveEntityName(grant.organizationId);
                    const grantee = grant.granteeId
                      ? resolveEntityName(grant.granteeId)
                      : null;
                    return (
                      <tr
                        key={grant.id}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <td className="py-2.5 px-3 max-w-[20rem]">
                          <span className="line-clamp-1">{grant.name}</span>
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {grantee ?? "-"}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {grant.amount
                            ? formatFunding(String(grant.amount))
                            : "-"}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {funder}
                        </td>
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {grant.date ?? "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Funding by Funder */}
        {fundingByOrg.length > 0 && (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Funding by Funder
            </h2>
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3 text-left font-medium">Funder</th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Grants
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Total Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {fundingByOrg.map((f) => {
                    const resolved = resolveEntityLink(f.organizationId);
                    return (
                      <tr
                        key={f.organizationId}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <td className="py-2.5 px-3">
                          {resolved.href ? (
                            <Link
                              href={resolved.href}
                              className="font-medium hover:text-primary transition-colors"
                            >
                              {resolved.name}
                            </Link>
                          ) : (
                            <span className="font-medium">{resolved.name}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {f.grantCount}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {formatFunding(f.totalAmount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Key Papers / Resources */}
        {papers.length > 0 && (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Key Papers &amp; Resources
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {papers.length}
              </span>
            </h2>
            <div className="space-y-2">
              {papers.map((paper) => (
                <div
                  key={paper.id}
                  className="px-4 py-3 rounded-lg border border-border/60 bg-card"
                >
                  <div className="flex items-start gap-2">
                    {paper.isSeminal && (
                      <span className="mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        SEMINAL
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      {paper.url ? (
                        <a
                          href={paper.url}
                          className="font-medium text-sm hover:text-primary transition-colors"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {paper.title}
                        </a>
                      ) : (
                        <span className="font-medium text-sm">{paper.title}</span>
                      )}
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        {paper.authors && <span>{paper.authors}</span>}
                        {paper.publishedDate && <span>{paper.publishedDate}</span>}
                        {paper.citationCount != null &&
                          paper.citationCount > 0 && (
                            <span>{paper.citationCount} citations</span>
                          )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Child areas */}
        {children.length > 0 && (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Sub-Areas
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {children.length}
              </span>
            </h2>
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3 text-left font-medium">Name</th>
                    <th className="py-2.5 px-3 text-left font-medium">Status</th>
                    <th className="py-2.5 px-3 text-right font-medium">Orgs</th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Papers
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {children.map((child) => (
                    <tr
                      key={child.id}
                      className="hover:bg-muted/20 transition-colors"
                    >
                      <td className="py-2.5 px-3">
                        <Link
                          href={`/research-areas/${child.id}`}
                          className="font-medium hover:text-primary transition-colors"
                        >
                          {child.title}
                        </Link>
                        {child.description && (
                          <span className="block text-xs text-muted-foreground line-clamp-1 mt-0.5">
                            {child.description}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`text-xs font-medium ${
                            STATUS_COLORS[child.status] ?? ""
                          }`}
                        >
                          {child.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {child.orgCount ?? "-"}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {child.paperCount ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </EntityProfileShell>
  );
}
