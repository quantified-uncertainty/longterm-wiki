import type { Metadata } from "next";
import {
  getAllResources,
  getTypedEntities,
  getAllPublications,
} from "@/data";
import { ProfileStatCard } from "@/components/directory";

export const metadata: Metadata = {
  title: "Data Sources",
  description:
    "Overview of data pipelines and structured data sources feeding the Longterm Wiki — entities, resources, publications, and auto-update feeds.",
};

export default function DataSourcesPage() {
  const resources = getAllResources();
  const entities = getTypedEntities();
  const publications = getAllPublications();

  // Count entities by type
  const entityTypeCounts = new Map<string, number>();
  for (const e of entities) {
    const t = e.entityType ?? "unknown";
    entityTypeCounts.set(t, (entityTypeCounts.get(t) || 0) + 1);
  }
  const topEntityTypes = [...entityTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Count resources by type
  const resourceTypeCounts = new Map<string, number>();
  for (const r of resources) {
    resourceTypeCounts.set(r.type, (resourceTypeCounts.get(r.type) || 0) + 1);
  }
  const topResourceTypes = [...resourceTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // Resources with enrichment
  const enrichedCount = resources.filter(
    (r) => r.enrichment_status === "enriched" || r.enrichment_status === "reviewed"
  ).length;

  const stats = [
    { label: "Entities", value: String(entities.length) },
    { label: "Resources", value: String(resources.length) },
    { label: "Publications", value: String(publications.length) },
    { label: "Enriched Resources", value: String(enrichedCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Data Sources
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Overview of the structured data pipelines feeding the wiki. Entities,
          resources, and publications are sourced from YAML files, enrichment
          pipelines, and auto-update feeds.
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

      {/* Entity type breakdown */}
      <div className="mb-8 rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Entity Types
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {entityTypeCounts.size} types
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
          {topEntityTypes.map(([type, count]) => (
            <div
              key={type}
              className="flex items-center justify-between gap-2 min-w-0"
            >
              <span className="truncate text-muted-foreground" title={type}>
                {type}
              </span>
              <span className="tabular-nums font-medium text-foreground/70 shrink-0">
                {count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Resource type breakdown */}
      <div className="mb-8 rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Resource Types
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {resourceTypeCounts.size} types
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
          {topResourceTypes.map(([type, count]) => (
            <div
              key={type}
              className="flex items-center justify-between gap-2 min-w-0"
            >
              <span className="truncate text-muted-foreground" title={type}>
                {type}
              </span>
              <span className="tabular-nums font-medium text-foreground/70 shrink-0">
                {count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Data pipeline description */}
      <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-3">
          Data Pipeline
        </h2>
        <div className="space-y-3 text-sm text-muted-foreground">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium text-foreground/70 shrink-0">
              1
            </span>
            <div>
              <span className="font-medium text-foreground/80">YAML Source Data</span>
              <span className="ml-1">
                — Entity definitions, resources, and publications are authored as
                YAML files in <code className="text-xs bg-muted px-1 rounded">data/</code>.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium text-foreground/70 shrink-0">
              2
            </span>
            <div>
              <span className="font-medium text-foreground/80">Build Transform</span>
              <span className="ml-1">
                — <code className="text-xs bg-muted px-1 rounded">build-data.mjs</code> merges
                YAML, MDX frontmatter, and FactBase data into{" "}
                <code className="text-xs bg-muted px-1 rounded">database.json</code>.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium text-foreground/70 shrink-0">
              3
            </span>
            <div>
              <span className="font-medium text-foreground/80">Enrichment Pipeline</span>
              <span className="ml-1">
                — Resources are automatically fetched, classified, and enriched
                with metadata via the resource enrichment pipeline.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium text-foreground/70 shrink-0">
              4
            </span>
            <div>
              <span className="font-medium text-foreground/80">Auto-Update</span>
              <span className="ml-1">
                — Daily RSS feeds and web searches discover new developments and
                route them to relevant wiki pages.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
