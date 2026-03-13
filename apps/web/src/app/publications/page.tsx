import type { Metadata } from "next";
import {
  getAllPublications,
  getResourcesForPublication,
  getPagesForResource,
} from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { PublicationsTable, type PublicationRow } from "./publications-table";

export const metadata: Metadata = {
  title: "Publications",
  description:
    "Directory of publication venues tracked in the wiki, with credibility ratings, peer-review status, and resource counts.",
};

export default function PublicationsPage() {
  const publications = getAllPublications();

  const rows: PublicationRow[] = publications.map((pub) => {
    const resources = getResourcesForPublication(pub.id);
    const pageSet = new Set<string>();
    for (const r of resources) {
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
      resourceCount: resources.length,
      pageCount: pageSet.size,
    };
  });

  // Compute summary stats
  const totalResources = rows.reduce((s, r) => s + r.resourceCount, 0);
  const peerReviewedCount = rows.filter((r) => r.peerReviewed).length;
  const withCredibility = rows.filter((r) => r.credibility != null);
  const avgCredibility =
    withCredibility.length > 0
      ? (
          withCredibility.reduce((s, r) => s + r.credibility!, 0) /
          withCredibility.length
        ).toFixed(1)
      : "-";

  const stats = [
    { label: "Publications", value: String(rows.length) },
    { label: "Resources", value: String(totalResources) },
    { label: "Peer-Reviewed", value: String(peerReviewedCount) },
    { label: "Avg Credibility", value: String(avgCredibility) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Publications
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Publication venues tracked in the wiki, with credibility ratings and
          resource counts. Covers academic journals, preprint servers, company
          blogs, think tanks, and more.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <PublicationsTable publications={rows} />
    </div>
  );
}
