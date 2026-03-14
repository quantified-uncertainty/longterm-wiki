import type { Metadata } from "next";
import Link from "next/link";
import { getAllPublications, getAllResources, getPagesForResource } from "@/data";
import { ProfileStatCard } from "@/components/directory";

export const metadata: Metadata = {
  title: "Sources",
  description:
    "Overview of external resources and publication venues tracked in the wiki — papers, articles, reports, and credibility ratings.",
};

export default function SourcesPage() {
  const publications = getAllPublications();
  const resources = getAllResources();

  // Compute resource-level stats
  const peerReviewed = publications.filter((p) => p.peer_reviewed).length;
  const withSummary = resources.filter((r) => r.summary).length;
  const citedResources = resources.filter((r) => {
    const pages = getPagesForResource(r.id);
    return pages.length > 0;
  }).length;

  // Resource type breakdown
  const typeCounts = new Map<string, number>();
  for (const r of resources) {
    typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
  }
  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const stats = [
    { label: "Resources", value: String(resources.length), href: "/resources" },
    { label: "Publications", value: String(publications.length), href: "/publications" },
    { label: "Peer-Reviewed Venues", value: String(peerReviewed) },
    { label: "With Summaries", value: String(withSummary) },
    { label: "Cited by Pages", value: String(citedResources) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Sources
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          External resources (papers, articles, reports) and publication venues
          cited across the wiki. Resources are indexed from citations;
          publications define venue-level credibility ratings.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            href={stat.href}
          />
        ))}
      </div>

      {/* Resource type breakdown */}
      {topTypes.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">By Resource Type</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {topTypes.map(([type, count]) => (
              <ProfileStatCard
                key={type}
                label={type.charAt(0).toUpperCase() + type.slice(1) + "s"}
                value={String(count)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sub-section cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/resources"
          className="group block rounded-xl border border-border/60 bg-card p-6 no-underline transition-all hover:shadow-md hover:border-border"
        >
          <h3 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors">
            Resources
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {resources.length.toLocaleString()} external documents (papers,
            articles, reports) indexed from citations across wiki pages.
            Includes metadata, summaries, and credibility ratings.
          </p>
        </Link>

        <Link
          href="/publications"
          className="group block rounded-xl border border-border/60 bg-card p-6 no-underline transition-all hover:shadow-md hover:border-border"
        >
          <h3 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors">
            Publications
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {publications.length} publication venues with credibility ratings
            (1-5 scale). Maps domains to venues for automatic resource
            credibility assignment.
          </p>
        </Link>
      </div>
    </div>
  );
}
