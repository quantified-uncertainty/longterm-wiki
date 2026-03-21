import type { Metadata } from "next";
import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { ResourcesTable, type ResourceRow } from "./resources-table";

export const metadata: Metadata = {
  title: "Resources",
  description:
    "Directory of external resources — papers, articles, reports, and other sources cited across the wiki.",
};

export default function ResourcesPage() {
  const resources = getAllResources();

  const rows: ResourceRow[] = resources.map((r) => {
    const publication = getResourcePublication(r);
    const credibility = getResourceCredibility(r);
    const citingPages = getPagesForResource(r.id);

    return {
      id: r.id,
      title: r.title,
      url: r.url,
      type: r.type,
      publicationName: publication?.name ?? null,
      credibility: credibility ?? null,
      citingPageCount: citingPages.length,
      tags: r.tags ?? [],
      publishedDate: r.published_date ?? null,
      contextNote: r.context_note ?? null,
      resourceSubtype: r.resource_subtype ?? null,
      importanceScore: r.importance_score ?? null,
      enrichmentStatus: r.enrichment_status ?? null,
      citationCount: r.paper?.citation_count ?? null,
      karma: r.forum_post?.karma ?? null,
    };
  });

  // Compute summary stats
  const typeCounts = new Map<string, number>();
  for (const r of rows) {
    typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
  }
  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const withPublication = rows.filter((r) => r.publicationName != null).length;
  const withCredibility = rows.filter((r) => r.credibility != null).length;
  const citedByPages = rows.filter((r) => r.citingPageCount > 0).length;
  const withSummaries = resources.filter((r) => r.summary && r.summary.trim() !== "").length;
  const enriched = resources.filter((r) => r.enrichment_status === "enriched").length;

  const stats = [
    { label: "Total Resources", value: String(rows.length) },
    ...topTypes.map(([type, count]) => ({
      label: type.charAt(0).toUpperCase() + type.slice(1) + "s",
      value: String(count),
    })),
    { label: "With Publication", value: String(withPublication) },
    { label: "With Credibility", value: String(withCredibility) },
    { label: "Cited by Pages", value: String(citedByPages) },
    { label: "With Summaries", value: String(withSummaries) },
    { label: "Enriched", value: String(enriched) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Resources
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of external resources — papers, articles, reports, and other
          sources cited across the wiki. Each resource includes metadata,
          publication venue, and credibility ratings.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <ResourcesTable rows={rows} />
    </div>
  );
}
