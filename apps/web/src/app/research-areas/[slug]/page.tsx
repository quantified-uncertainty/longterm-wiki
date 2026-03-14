import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getResearchAreasFromPG } from "@/data/database";
import { CLUSTER_COLORS, STATUS_COLORS, formatCluster, formatFunding } from "../research-area-constants";

function getAreaBySlug(slug: string) {
  return getResearchAreasFromPG().find((a) => a.id === slug) ?? null;
}

function getAllSlugs(): string[] {
  return getResearchAreasFromPG().map((a) => a.id);
}

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

export default async function ResearchAreaDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const area = getAreaBySlug(slug);
  if (!area) return notFound();

  // Find child areas
  const allAreas = getResearchAreasFromPG();
  const children = allAreas.filter((a) => a.parentAreaId === area.id);
  const parent = area.parentAreaId
    ? allAreas.find((a) => a.id === area.parentAreaId)
    : null;

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
        <div className={`grid grid-cols-2 gap-3 mb-8 ${stats.length >= 4 ? "sm:grid-cols-4" : stats.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
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
                  <th className="py-2.5 px-3 text-right font-medium">Papers</th>
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
                      {child.orgCount || "-"}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      {child.paperCount || "-"}
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
