import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getResearchAreasFromPG, getEntityById } from "@/data/database";
import { getEntityHref } from "@/data/entity-nav";
import {
  CLUSTER_COLORS,
  STATUS_COLORS,
  formatCluster,
  formatFunding,
} from "../research-area-constants";
import { fetchFromWikiServer } from "@/lib/wiki-server";

// ---------------------------------------------------------------------------
// Types for the enriched detail response from wiki-server
// ---------------------------------------------------------------------------

interface AreaDetailGrant {
  id: string;
  name: string;
  amount: number | null;
  date: string | null;
  organizationId: string;
  granteeId: string | null;
  confidence: number | null;
}

interface AreaDetailFundingByOrg {
  organizationId: string;
  grantCount: number;
  totalAmount: string;
}

interface AreaDetailPaper {
  id: number;
  resourceId: string | null;
  title: string;
  url: string | null;
  authors: string | null;
  publishedDate: string | null;
  citationCount: number | null;
  isSeminal: boolean;
  sortOrder: number;
  notes: string | null;
}

interface AreaDetailOrg {
  organizationId: string;
  role: string;
  notes: string | null;
}

interface AreaDetailResponse {
  grants: AreaDetailGrant[];
  fundingByOrg: AreaDetailFundingByOrg[];
  papers: AreaDetailPaper[];
  organizations: AreaDetailOrg[];
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function getAreaBySlug(slug: string) {
  return getResearchAreasFromPG().find((a) => a.id === slug) ?? null;
}

function getAllSlugs(): string[] {
  return getResearchAreasFromPG().map((a) => a.id);
}

function resolveEntityName(id: string): string {
  const entity = getEntityById(id);
  return entity?.title ?? id;
}

function resolveEntityLink(id: string): { name: string; href: string | null } {
  const entity = getEntityById(id);
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

  // Find child areas from build-time data
  const allAreas = getResearchAreasFromPG();
  const children = allAreas.filter((a) => a.parentAreaId === area.id);
  const parent = area.parentAreaId
    ? allAreas.find((a) => a.id === area.parentAreaId)
    : null;

  // Fetch rich detail from wiki-server (ISR, 5 min revalidation)
  const detail = await fetchFromWikiServer<AreaDetailResponse>(
    `/api/research-areas/${slug}`,
    { revalidate: 300 }
  );

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

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-6">
        <Link
          href="/research-areas"
          className="hover:text-foreground transition-colors"
        >
          Research Areas
        </Link>
        {parent && (
          <>
            <span>/</span>
            <Link
              href={`/research-areas/${parent.id}`}
              className="hover:text-foreground transition-colors"
            >
              {parent.title}
            </Link>
          </>
        )}
        <span>/</span>
        <span className="text-foreground font-medium">{area.title}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {area.title}
          </h1>
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
        </div>
        {area.description && (
          <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">
            {area.description}
          </p>
        )}
        {area.numericId && (
          <div className="mt-3 text-sm">
            <Link
              href={`/wiki/${area.numericId}`}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          </div>
        )}
      </div>

      {/* Stat cards */}
      {stats.length > 0 && (
        <div
          className={`grid grid-cols-2 gap-3 mb-8 ${stats.length >= 4 ? "sm:grid-cols-4" : stats.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
        >
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
                {stat.label}
              </div>
              <div className="text-2xl font-bold tabular-nums tracking-tight">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Details */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8 text-sm">
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

      {/* Tags */}
      {area.tags.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Tags
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {area.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Organizations */}
      {organizations.length > 0 && (
        <section className="mb-8">
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
        <section className="mb-8">
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
        <section className="mb-8">
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
        <section className="mb-8">
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
        <section className="mb-8">
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
  );
}
