import {
  getAllPublications,
  getResourcesForPublication,
  getPagesForResource,
} from "@/data";
import {
  PublicationsDataTable,
  type PublicationDataRow,
} from "./publications-data-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Publications | Longterm Wiki",
  description:
    "Publication venues tracked in the wiki, with credibility ratings.",
};

export default function PublicationsPage() {
  const publications = getAllPublications();

  const rows: PublicationDataRow[] = publications.map((pub) => {
    const resources = getResourcesForPublication(pub.id);
    // Collect unique citing pages across all resources
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
      credibility: pub.credibility,
      peerReviewed: pub.peer_reviewed ?? false,
      resourceCount: resources.length,
      pageCount: pageSet.size,
      domains: pub.domains,
    };
  });

  const totalResources = rows.reduce((s, r) => s + r.resourceCount, 0);
  const peerReviewedCount = rows.filter((r) => r.peerReviewed).length;
  const avgCredibility =
    rows.length > 0
      ? (rows.reduce((s, r) => s + r.credibility, 0) / rows.length).toFixed(1)
      : "0";

  return (
    <article className="prose max-w-none">
      <h1>Publications</h1>
      <p className="text-muted-foreground">
        Publication venues tracked in the wiki data layer.{" "}
        <span className="font-medium text-foreground">
          {publications.length}
        </span>{" "}
        publications covering{" "}
        <span className="font-medium text-foreground">{totalResources}</span>{" "}
        resources.
      </p>

      {/* Summary stats */}
      <div className="not-prose grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Publications" value={publications.length} />
        <StatCard label="Resources" value={totalResources} />
        <StatCard label="Peer-reviewed" value={peerReviewedCount} />
        <StatCard label="Avg credibility" value={avgCredibility} />
      </div>

      <PublicationsDataTable publications={rows} />
    </article>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
