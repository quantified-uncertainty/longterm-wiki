import type { Metadata } from "next";
import Link from "next/link";
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { fetchAllPaginated } from "@lib/fetch-paginated";
import { StatCard } from "@components/internal/StatCard";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getEntityById } from "@data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Statements Explorer | Longterm Wiki",
  description:
    "Browse structured facts and attributed claims about AI safety entities.",
};

// ---- Types ----

interface StatsResponse {
  total: number;
  byVariety: Record<string, number>;
  byStatus: Record<string, number>;
  propertiesCount: number;
}

interface PropertyRow {
  id: string;
  label: string;
  category: string;
  description: string | null;
  valueType: string;
  unitFormatId: string | null;
  statementCount: number;
}

interface StatementSummary {
  id: number;
  variety: string;
  status: string;
  subjectEntityId: string;
  propertyId: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  validStart: string | null;
  createdAt: string;
  citationCount?: number;
}

interface OverviewData {
  stats: StatsResponse;
  properties: PropertyRow[];
  recentStatements: StatementSummary[];
}

/**
 * Paginate through all statements from the API using the shared helper.
 */
async function fetchAllStatementsDetailed(): Promise<
  FetchResult<{ statements: StatementSummary[]; total: number }>
> {
  const result = await fetchAllPaginated<StatementSummary>({
    path: "/api/statements",
    itemsKey: "statements",
    pageSize: 500,
    revalidate: 300,
  });
  if (!result.ok) return result;
  return { ok: true, data: { statements: result.data.items, total: result.data.total } };
}

async function loadFromApi(): Promise<FetchResult<OverviewData>> {
  const [statsResult, propertiesResult, recentResult] = await Promise.all([
    fetchDetailed<StatsResponse>("/api/statements/stats", { revalidate: 300 }),
    fetchDetailed<{ properties: PropertyRow[] }>("/api/statements/properties", {
      revalidate: 300,
    }),
    fetchAllStatementsDetailed(),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!propertiesResult.ok) return propertiesResult;
  if (!recentResult.ok) return recentResult;

  return {
    ok: true,
    data: {
      stats: statsResult.data,
      properties: propertiesResult.data.properties,
      recentStatements: recentResult.data.statements,
    },
  };
}

function noLocalFallback(): OverviewData {
  return {
    stats: { total: 0, byVariety: {}, byStatus: {}, propertiesCount: 0 },
    properties: [],
    recentStatements: [],
  };
}

// ---- Category colors ----

const CATEGORY_COLORS: Record<string, string> = {
  financial: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  organizational: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  safety: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  performance: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  milestone: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  relation: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

export default async function StatementsOverviewPage() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { stats, properties, recentStatements } = data;
  const structured = stats.byVariety["structured"] ?? 0;
  const attributed = stats.byVariety["attributed"] ?? 0;
  const active = stats.byStatus["active"] ?? 0;
  const superseded = stats.byStatus["superseded"] ?? 0;

  // Build per-entity counts
  const entityCounts = new Map<string, number>();
  for (const s of recentStatements) {
    entityCounts.set(
      s.subjectEntityId,
      (entityCounts.get(s.subjectEntityId) ?? 0) + 1
    );
  }
  const topEntities = [...entityCounts.entries()]
    .map(([entityId, count]) => ({
      entityId,
      title: getEntityById(entityId)?.title ?? entityId,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Category breakdown
  const byCategory = new Map<string, { statementCount: number; propertyCount: number }>();
  for (const p of properties) {
    const entry = byCategory.get(p.category) ?? { statementCount: 0, propertyCount: 0 };
    entry.statementCount += p.statementCount;
    entry.propertyCount += 1;
    byCategory.set(p.category, entry);
  }
  const categoryRows = [...byCategory.entries()]
    .sort((a, b) => b[1].statementCount - a[1].statementCount);

  // Top properties
  const topProperties = [...properties]
    .sort((a, b) => b.statementCount - a.statementCount)
    .slice(0, 10);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Statements Explorer</h1>
      <p className="text-muted-foreground mb-6">
        Structured facts and attributed claims about AI safety entities.{" "}
        <span className="font-medium text-foreground">
          {stats.total.toLocaleString()}
        </span>{" "}
        total statements across{" "}
        <span className="font-medium text-foreground">
          {entityCounts.size}
        </span>{" "}
        entities.
      </p>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-8">
        <StatCard label="Total Statements" value={stats.total} />
        <StatCard label="Active" value={active} color="emerald" />
        <StatCard label="Structured" value={structured} color="blue" />
        <StatCard label="Attributed" value={attributed} color="amber" />
        <StatCard label="Properties" value={stats.propertiesCount} />
        <StatCard label="Entities" value={entityCounts.size} />
        {superseded > 0 && (
          <StatCard label="Superseded" value={superseded} />
        )}
      </div>

      {/* Category breakdown */}
      {categoryRows.length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">Property Categories</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {categoryRows.map(([category, data]) => (
              <Link
                key={category}
                href={`/statements/browse?category=${category}`}
                className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 hover:bg-muted/50 transition-colors no-underline"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium capitalize ${CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-800"}`}
                  >
                    {category}
                  </span>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">
                    {data.statementCount}
                  </span>{" "}
                  stmts
                  <span className="text-muted-foreground/60 ml-1">
                    ({data.propertyCount} props)
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Top properties */}
      {topProperties.length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Top Properties</h3>
            <Link
              href="/statements/properties"
              className="text-xs text-blue-600 hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="space-y-1.5">
            {topProperties.map((prop) => (
              <Link
                key={prop.id}
                href={`/statements/browse?propertyId=${prop.id}`}
                className="flex items-center gap-3 no-underline"
              >
                <span className="text-sm text-foreground w-40 truncate">
                  {prop.label}
                </span>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-400 dark:bg-blue-600 rounded-l"
                      style={{
                        width: `${topProperties[0].statementCount > 0 ? (prop.statementCount / topProperties[0].statementCount) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs tabular-nums w-6 text-right text-muted-foreground">
                    {prop.statementCount}
                  </span>
                </div>
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${CATEGORY_COLORS[prop.category] ?? "bg-gray-100 text-gray-800"}`}
                >
                  {prop.category}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Top entities */}
      {topEntities.length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">
            Top Entities by Statement Count
          </h3>
          <div className="space-y-1.5">
            {topEntities.map((entity) => (
              <div key={entity.entityId} className="flex items-center gap-3">
                <Link
                  href={`/statements/entity/${entity.entityId}`}
                  className="text-sm text-blue-600 hover:underline w-40 truncate"
                >
                  {entity.title}
                </Link>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-400 dark:bg-blue-600 rounded-l"
                      style={{
                        width: `${topEntities[0].count > 0 ? (entity.count / topEntities[0].count) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs tabular-nums w-6 text-right text-muted-foreground">
                    {entity.count}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </div>
  );
}
