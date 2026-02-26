import type { Metadata } from "next";
import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@/data";
import { ResourcesTable } from "./resources-table";
import type { ResourceRow } from "./resources-table";

export const metadata: Metadata = {
  title: "Resources — Claims Explorer | Longterm Wiki",
  description:
    "Browse external resources (papers, articles, reports) referenced across wiki pages.",
};

function deriveFetchStatus(
  r: { local_filename?: string; fetched_at?: string }
): "full" | "metadata-only" | "unfetched" {
  if (r.local_filename) return "full";
  if (r.fetched_at) return "metadata-only";
  return "unfetched";
}

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
      publishedDate: r.published_date ?? null,
      hasSummary: !!r.summary,
      hasReview: !!r.review,
      hasKeyPoints: !!(r.key_points && r.key_points.length > 0),
      fetchStatus: deriveFetchStatus(r),
      authors: r.authors ?? null,
      tags: r.tags ?? [],
    };
  });

  const total = rows.length;
  const cited = rows.filter((r) => r.citingPageCount > 0).length;
  const withSummary = rows.filter((r) => r.hasSummary).length;
  const fetched = rows.filter((r) => r.fetchStatus === "full").length;

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-1">
        <h1 className="text-2xl font-bold">Resources</h1>
        <span className="text-sm text-muted-foreground">
          {total.toLocaleString()} total
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        External resources referenced across wiki pages.{" "}
        <span className="text-foreground">{cited.toLocaleString()}</span> cited
        by pages &middot;{" "}
        <span className="text-foreground">{withSummary.toLocaleString()}</span>{" "}
        with summary &middot;{" "}
        <span className="text-foreground">{fetched.toLocaleString()}</span>{" "}
        snapshots saved
      </p>

      <ResourcesTable resources={rows} />
    </div>
  );
}
