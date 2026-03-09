import Link from "next/link";
import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
} from "@/data/kb";
import type { Fact } from "@longterm-wiki/kb";
import { Database, BarChart3, Layers, BookOpen } from "lucide-react";

/**
 * Gather all KB facts across all entities.
 * Excludes description-only facts for the "structured" count.
 */
function computeStats() {
  const entities = getKBEntities();
  const properties = getKBProperties();

  let totalFacts = 0;
  let structuredFacts = 0;
  let factsWithSource = 0;
  let entitiesWithStructuredData = 0;
  const propertyUsage = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const entity of entities) {
    const facts: Fact[] = getKBFacts(entity.id);
    totalFacts += facts.length;

    const structured = facts.filter((f) => f.propertyId !== "description");
    structuredFacts += structured.length;

    if (structured.length > 0) {
      entitiesWithStructuredData++;
    }

    for (const fact of structured) {
      factsWithSource += fact.source || fact.sourceResource ? 1 : 0;
      propertyUsage.set(
        fact.propertyId,
        (propertyUsage.get(fact.propertyId) ?? 0) + 1
      );
    }
  }

  for (const prop of properties) {
    if (prop.category && propertyUsage.has(prop.id)) {
      categoryCounts.set(
        prop.category,
        (categoryCounts.get(prop.category) ?? 0) +
          (propertyUsage.get(prop.id) ?? 0)
      );
    }
  }

  const propertiesInUse = propertyUsage.size;
  const sourceCoverage =
    structuredFacts > 0
      ? Math.round((factsWithSource / structuredFacts) * 100)
      : 0;

  return {
    totalEntities: entities.length,
    entitiesWithStructuredData,
    totalFacts,
    structuredFacts,
    propertiesInUse,
    totalProperties: properties.length,
    sourceCoverage,
    categoryCounts,
  };
}

function StatCard({
  icon: Icon,
  label,
  value,
  sublabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sublabel?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sublabel && (
        <div className="text-xs text-muted-foreground mt-1">{sublabel}</div>
      )}
    </div>
  );
}

export function KBOverviewContent() {
  const stats = computeStats();

  const sortedCategories = [...stats.categoryCounts.entries()].sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        The Knowledge Base (KB) stores structured, sourced facts about entities
        tracked by this wiki. Each fact has a typed value, optional date stamp,
        and source attribution. This section lets you explore the full dataset.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={Database}
          label="Structured Facts"
          value={stats.structuredFacts}
          sublabel={`${stats.totalFacts} total including descriptions`}
        />
        <StatCard
          icon={Layers}
          label="Entities with Data"
          value={stats.entitiesWithStructuredData}
          sublabel={`of ${stats.totalEntities} total KB entities`}
        />
        <StatCard
          icon={BarChart3}
          label="Properties in Use"
          value={stats.propertiesInUse}
          sublabel={`of ${stats.totalProperties} defined`}
        />
        <StatCard
          icon={BookOpen}
          label="Source Coverage"
          value={`${stats.sourceCoverage}%`}
          sublabel="of structured facts have sources"
        />
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        <Link
          href="/wiki/E1020"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Facts Explorer
          </h3>
          <p className="text-sm text-muted-foreground">
            Browse and filter all {stats.structuredFacts} structured facts.
            Search by entity, property, or category.
          </p>
        </Link>
        <Link
          href="/wiki/E1021"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Properties Explorer
          </h3>
          <p className="text-sm text-muted-foreground">
            View all {stats.totalProperties} property definitions with usage
            stats and coverage bars.
          </p>
        </Link>
        <Link
          href="/wiki/E1022"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Entity Coverage
          </h3>
          <p className="text-sm text-muted-foreground">
            See which entities have the most data and which need more coverage.
          </p>
        </Link>
      </div>

      {sortedCategories.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Facts by Category</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {sortedCategories.map(([category, count]) => (
              <div
                key={category}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <span className="text-sm capitalize">{category}</span>
                <span className="text-sm font-medium tabular-nums text-muted-foreground">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
