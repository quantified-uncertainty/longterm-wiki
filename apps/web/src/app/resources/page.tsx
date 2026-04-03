import type { Metadata } from "next";
import {
  getAllPublications,
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
    "External resources cited across the wiki — papers, articles, reports, and other references with credibility ratings and enrichment status.",
};

const ENRICHMENT_STAGES: readonly {
  key: string;
  label: string;
  color: string;
}[] = [
  { key: "none", label: "Not Started", color: "bg-zinc-300 dark:bg-zinc-700" },
  {
    key: "pending",
    label: "Pending",
    color: "bg-amber-400 dark:bg-amber-600",
  },
  { key: "fetched", label: "Fetched", color: "bg-sky-400 dark:bg-sky-600" },
  {
    key: "classified",
    label: "Classified",
    color: "bg-violet-400 dark:bg-violet-600",
  },
  {
    key: "enriched",
    label: "Enriched",
    color: "bg-emerald-500 dark:bg-emerald-600",
  },
  {
    key: "reviewed",
    label: "Reviewed",
    color: "bg-emerald-700 dark:bg-emerald-400",
  },
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

export default function ResourcesPage() {
  const publications = getAllPublications();
  const resources = getAllResources();

  // Build resource rows for the table.
  // Only ship resources that are cited by at least one page or have enrichment
  // data — this avoids sending 21k+ rows (16 MB+) to the client when most
  // uncited resources add no value to the directory view.
  const allResourceRows: ResourceRow[] = resources.map((r) => {
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
      contextNote: null, // Omit long text — not shown in table columns
      resourceSubtype: r.resource_subtype ?? null,
      importanceScore: r.importance_score ?? null,
      enrichmentStatus: r.enrichment_status ?? null,
      citationCount: r.paper?.citation_count ?? null,
      karma: r.forum_post?.karma ?? null,
    };
  });

  // Filter to resources worth showing: cited by pages, enriched, or high credibility
  const resourceRows = allResourceRows.filter(
    (r) => r.citingPageCount > 0 || r.enrichmentStatus === "enriched" || r.enrichmentStatus === "reviewed" || (r.credibility !== null && r.credibility >= 3)
  );

  // Resource type breakdown
  const typeCounts = new Map<string, number>();
  for (const r of resourceRows) {
    typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
  }
  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  // Compute summary stats
  const peerReviewed = publications.filter((p) => p.peer_reviewed).length; // publication venues, not individual resources
  const withSummary = resources.filter((r) => r.summary).length;
  const citedResources = resources.filter((r) => {
    const pages = getPagesForResource(r.id);
    return pages.length > 0;
  }).length;
  const enriched = resources.filter(
    (r) => r.enrichment_status === "enriched" || r.enrichment_status === "reviewed"
  ).length;

  const stats = [
    { label: "Resources", value: String(resources.length) },
    ...topTypes.map(([type, count]) => ({
      label: type.charAt(0).toUpperCase() + type.slice(1) + "s",
      value: String(count),
    })),
    { label: "Peer-Reviewed Venues", value: String(peerReviewed) },
    { label: "With Summaries", value: String(withSummary) },
    { label: "Cited by Pages", value: String(citedResources) },
    { label: "Enriched", value: String(enriched) },
  ];

  // Domain breakdown — group resources by hostname
  const domainCounts = new Map<string, number>();
  for (const r of resources) {
    if (!r.url) continue;
    try {
      const hostname = new URL(r.url).hostname;
      domainCounts.set(hostname, (domainCounts.get(hostname) || 0) + 1);
    } catch {
      // skip malformed URLs
    }
  }
  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Enrichment pipeline breakdown
  const enrichmentCounts = new Map<string, number>();
  for (const r of resources) {
    const status = r.enrichment_status ?? "none";
    enrichmentCounts.set(status, (enrichmentCounts.get(status) || 0) + 1);
  }
  // Ordered by pipeline stage, with unknown stages collected as "other"
  const knownKeys = new Set(ENRICHMENT_STAGES.map((s) => s.key));
  const enrichmentStats = ENRICHMENT_STAGES.filter((s) =>
    enrichmentCounts.has(s.key)
  ).map((s) => ({ stage: s.key, count: enrichmentCounts.get(s.key)! }));
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
          Resources
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          External resources (papers, articles, reports) cited across the wiki.
          Resources are indexed from citations; each entry tracks credibility,
          enrichment status, and linking pages.
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

      {/* Enrichment pipeline progress */}
      {resources.length > 0 && (
        <div className="mb-8 rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Enrichment Pipeline
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {enrichmentStats
                .filter(
                  (s) => s.stage === "enriched" || s.stage === "reviewed"
                )
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
                <span
                  className={`inline-block w-2 h-2 rounded-sm ${enrichmentStageColor(stage)}`}
                />
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

      {/* Domain breakdown — top 20 domains by resource count */}
      {topDomains.length > 0 && (
        <div className="mb-8 rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Top Domains
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {domainCounts.size.toLocaleString()} unique domains
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-x-6 gap-y-1.5 text-xs">
            {topDomains.map(([domain, count]) => (
              <div
                key={domain}
                className="flex items-center justify-between gap-2 min-w-0"
              >
                <span
                  className="truncate text-muted-foreground"
                  title={domain}
                >
                  {domain}
                </span>
                <span className="tabular-nums font-medium text-foreground/70 shrink-0">
                  {count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {resourceRows.length < resources.length && (
        <p className="text-xs text-muted-foreground mb-3">
          Showing {resourceRows.length.toLocaleString()} of{" "}
          {resources.length.toLocaleString()} resources (cited by pages, enriched,
          or credibility &ge; 3). Use individual resource pages for the full catalog.
        </p>
      )}
      <ResourcesTable rows={resourceRows} />
    </div>
  );
}
