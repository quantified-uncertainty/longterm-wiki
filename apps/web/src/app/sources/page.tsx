import type { Metadata } from "next";
import {
  getAllPublications,
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
  getResourcesForPublication,
} from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { SourcesTabs } from "./sources-tabs";
import type { ResourceRow } from "../resources/resources-table";
import type { PublicationRow } from "../publications/publications-table";

export const metadata: Metadata = {
  title: "Sources",
  description:
    "Overview of external resources and publication venues tracked in the wiki — papers, articles, reports, and credibility ratings.",
};

export default function SourcesPage() {
  const publications = getAllPublications();
  const resources = getAllResources();

  // Build resource rows for the table
  const resourceRows: ResourceRow[] = resources.map((r) => {
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
    };
  });

  // Build publication rows for the table
  const publicationRows: PublicationRow[] = publications.map((pub) => {
    const pubResources = getResourcesForPublication(pub.id);
    const pageSet = new Set<string>();
    for (const r of pubResources) {
      for (const pageId of getPagesForResource(r.id)) {
        pageSet.add(pageId);
      }
    }
    return {
      id: pub.id,
      name: pub.name,
      type: pub.type,
      credibility: pub.credibility ?? null,
      peerReviewed: pub.peer_reviewed ?? false,
      resourceCount: pubResources.length,
      pageCount: pageSet.size,
    };
  });

  // Compute summary stats
  const peerReviewed = publications.filter((p) => p.peer_reviewed).length;
  const withSummary = resources.filter((r) => r.summary).length;
  const citedResources = resources.filter((r) => {
    const pages = getPagesForResource(r.id);
    return pages.length > 0;
  }).length;

  const stats = [
    { label: "Resources", value: String(resources.length) },
    { label: "Publications", value: String(publications.length) },
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
          />
        ))}
      </div>

      <SourcesTabs
        resourceRows={resourceRows}
        resourceCount={resources.length}
        publicationRows={publicationRows}
        publicationCount={publications.length}
      />
    </div>
  );
}
