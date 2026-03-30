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

const ENRICHMENT_STAGES: readonly {
  key: string;
  label: string;
  color: string;
}[] = [
  { key: "none", label: "Not Started", color: "bg-zinc-300 dark:bg-zinc-700" },
  { key: "pending", label: "Pending", color: "bg-amber-400 dark:bg-amber-600" },
  { key: "fetched", label: "Fetched", color: "bg-sky-400 dark:bg-sky-600" },
  { key: "classified", label: "Classified", color: "bg-violet-400 dark:bg-violet-600" },
  { key: "enriched", label: "Enriched", color: "bg-emerald-500 dark:bg-emerald-600" },
  { key: "reviewed", label: "Reviewed", color: "bg-emerald-700 dark:bg-emerald-400" },
];

const STAGE_LOOKUP = Object.fromEntries(
  ENRICHMENT_STAGES.map((s) => [s.key, s])
);

function stageLabel(stage: string): string {
  return STAGE_LOOKUP[stage]?.label ?? stage;
}

function enrichmentStageColor(stage: string): string {
  return STAGE_LOOKUP[stage]?.color ?? "bg-zinc-400";
}

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
      contextNote: r.context_note ?? null,
      resourceSubtype: r.resource_subtype ?? null,
      importanceScore: r.importance_score ?? null,
      enrichmentStatus: r.enrichment_status ?? null,
      citationCount: r.paper?.citation_count ?? null,
      karma: r.forum_post?.karma ?? null,
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

  // Enrichment pipeline breakdown
  const enrichmentCounts = new Map<string, number>();
  for (const r of resources) {
    const status = r.enrichment_status ?? "none";
    enrichmentCounts.set(status, (enrichmentCounts.get(status) || 0) + 1);
  }
  // Ordered by pipeline stage, with unknown stages collected as "other"
  const knownKeys = new Set(ENRICHMENT_STAGES.map((s) => s.key));
  const enrichmentStats = ENRICHMENT_STAGES
    .filter((s) => enrichmentCounts.has(s.key))
    .map((s) => ({ stage: s.key, count: enrichmentCounts.get(s.key)! }));
  let otherCount = 0;
  for (const [key, count] of enrichmentCounts) {
    if (!knownKeys.has(key)) otherCount += count;
  }
  if (otherCount > 0) {
    enrichmentStats.push({ stage: "other", count: otherCount });
  }

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

      {/* Enrichment pipeline progress — hidden when no resources */}
      {resources.length > 0 && (
        <div className="mb-8 rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Enrichment Pipeline
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {enrichmentStats
                .filter((s) => s.stage === "enriched" || s.stage === "reviewed")
                .reduce((sum, s) => sum + s.count, 0)
                .toLocaleString()}{" "}
              / {resources.length.toLocaleString()} enriched
            </span>
          </div>
          <div className="flex h-3 rounded-full overflow-hidden mb-4 bg-muted/40">
            {enrichmentStats.map(({ stage, count }) => (
              <div
                key={stage}
                className={`${enrichmentStageColor(stage)}`}
                style={{ width: `${(count / resources.length) * 100}%` }}
                title={`${stageLabel(stage)}: ${count.toLocaleString()} (${Math.round((count / resources.length) * 100)}%)`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            {enrichmentStats.map(({ stage, count }) => (
              <span key={stage} className="flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-sm ${enrichmentStageColor(stage)}`} />
                <span>{stageLabel(stage)}</span>
                <span className="tabular-nums font-medium text-foreground/70">
                  {count.toLocaleString()}
                </span>
                <span className="tabular-nums text-muted-foreground/50">
                  ({Math.round((count / resources.length) * 100)}%)
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <SourcesTabs
        resourceRows={resourceRows}
        resourceCount={resources.length}
        publicationRows={publicationRows}
        publicationCount={publications.length}
      />
    </div>
  );
}
