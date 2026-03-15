import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@/data";
import type { Resource } from "@/data";
import { ResourcesDataTable } from "@/app/internal/resources/resources-data-table";
import type { ResourceDataRow } from "@/app/internal/resources/resources-data-table";

function deriveFetchStatus(r: Resource): "full" | "metadata-only" | "unfetched" {
  if (r.local_filename) return "full";
  if (r.fetched_at) return "metadata-only";
  return "unfetched";
}

export function FBResourcesContent() {
  let resources;
  try {
    resources = getAllResources();
  } catch (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive font-medium">Failed to load resources data</p>
        <p className="text-sm text-muted-foreground mt-2">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const rows: ResourceDataRow[] = resources.map((r) => {
    const publication = getResourcePublication(r);
    const credibility = getResourceCredibility(r);
    const citingPages = getPagesForResource(r.id);
    const fetchStatus = deriveFetchStatus(r);

    return {
      id: r.id,
      title: r.title,
      url: r.url,
      type: r.type,
      fetchStatus,
      fetchedAt: r.fetched_at ?? null,
      hasSummary: !!r.summary,
      hasReview: !!r.review,
      hasKeyPoints: !!r.key_points && r.key_points.length > 0,
      publicationName: publication?.name ?? null,
      credibility: credibility ?? null,
      citingPageCount: citingPages.length,
      tags: r.tags ?? [],
      publishedDate: r.published_date ?? null,
    };
  });

  const fetched = rows.filter((r) => r.fetchStatus === "full").length;
  const metadataOnly = rows.filter((r) => r.fetchStatus === "metadata-only").length;
  const unfetched = rows.filter((r) => r.fetchStatus === "unfetched").length;
  const withSummary = rows.filter((r) => r.hasSummary).length;
  const withReview = rows.filter((r) => r.hasReview).length;
  const cited = rows.filter((r) => r.citingPageCount > 0).length;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        External resources (papers, articles, reports) tracked in{" "}
        <code>data/resources/*.yaml</code>.{" "}
        <span className="font-medium text-foreground">{resources.length}</span>{" "}
        total resources.
      </p>

      <div className="not-prose grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-6">
        <StatCard label="Full text fetched" value={fetched} total={resources.length} color="emerald" />
        <StatCard label="Metadata only" value={metadataOnly} total={resources.length} color="amber" />
        <StatCard label="Unfetched" value={unfetched} total={resources.length} color="red" />
        <StatCard label="With summary" value={withSummary} total={resources.length} color="blue" />
        <StatCard label="With review" value={withReview} total={resources.length} color="purple" />
        <StatCard label="Cited by pages" value={cited} total={resources.length} color="teal" />
      </div>

      <ResourcesDataTable resources={rows} />
    </>
  );
}

const colorClasses: Record<string, string> = {
  emerald: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-600",
  blue: "text-blue-600",
  purple: "text-purple-600",
  teal: "text-teal-600",
};

function StatCard({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className={`text-2xl font-bold tabular-nums ${colorClasses[color] ?? ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
      <div className="text-[10px] text-muted-foreground/60 tabular-nums">{pct}%</div>
    </div>
  );
}
