import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  getWikiServerConfig,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ThingsTable, type ThingRow } from "./things-table";
import { getEntityHref } from "@data/entity-nav";

// ── Types ─────────────────────────────────────────────────────────────────

interface ThingsApiItem {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  sourceUrl: string | null;
  numericId: string | null;
  verdict: string | null;
  verdictConfidence: number | null;
  verdictAt: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string;
}

interface ThingsListResult {
  things: ThingsApiItem[];
  total: number;
  limit: number;
  offset: number;
}

interface ThingsStatsResult {
  total: number;
  byType: Record<string, number>;
  byVerdict: Record<string, number>;
  byEntityType: Record<string, number>;
}

interface DashboardData {
  stats: ThingsStatsResult;
  items: ThingsApiItem[];
  total: number;
}

// ── Detail page URL mapping ──────────────────────────────────────────────
// Maps thingType → URL prefix for types with dedicated detail pages.

const THING_DETAIL_ROUTES: Record<string, string> = {
  grant: "/grants",
  resource: "/resources",
  division: "/divisions",
  "funding-program": "/funding-programs",
  "funding-round": "/funding-rounds",
  investment: "/investments",
  benchmark: "/benchmarks",
};

/**
 * Resolve the best internal href for any thing type.
 * Priority: dedicated detail page > entity page > sourceUrl > undefined
 */
function resolveThingHref(item: ThingsApiItem): string | undefined {
  // Entities: use entity href resolution (handles directory pages, wiki pages)
  if (item.thingType === "entity") {
    if (item.numericId) {
      // Try directory href first via getEntityHref (which prefers directory URLs)
      return getEntityHref(item.sourceId);
    }
    return getEntityHref(item.sourceId);
  }

  // Things with dedicated detail pages
  const routePrefix = THING_DETAIL_ROUTES[item.thingType];
  if (routePrefix && item.sourceId) {
    return `${routePrefix}/${encodeURIComponent(item.sourceId)}`;
  }

  // Facts: link to the parent entity's page (sourceId format: "entityId:factId")
  if (item.thingType === "fact" && item.sourceId.includes(":")) {
    const entityId = decodeURIComponent(item.sourceId.split(":")[0]);
    try {
      return getEntityHref(entityId);
    } catch {
      // Entity not in database.json — skip
    }
  }

  // Benchmark results: link to parent benchmark
  if (item.thingType === "benchmark-result" && item.sourceId) {
    // sourceId is the benchmark_result PG ID; the title contains "model on benchmark: score"
    // Try extracting benchmark ID from parentThingId later (handled in row building)
  }

  return undefined;
}

/**
 * Resolve the parent entity href for a thing using the loaded things map.
 * Walks the parent chain up to 3 levels to find the nearest entity ancestor.
 */
function resolveParentEntityHref(
  item: ThingsApiItem,
  thingMap: Map<string, ThingsApiItem>,
  depth = 0,
): { title: string; href: string } | undefined {
  if (depth > 3 || !item.parentThingId) return undefined;

  const parent = thingMap.get(item.parentThingId);
  if (!parent) return undefined;

  if (parent.thingType === "entity") {
    const href = getEntityHref(parent.sourceId);
    return { title: parent.title, href };
  }

  // Walk up the chain (e.g., division-personnel -> division -> org entity)
  return resolveParentEntityHref(parent, thingMap, depth + 1);
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, itemsResult] = await Promise.all([
    fetchDetailed<ThingsStatsResult>("/api/things/stats", { revalidate: 60 }),
    fetchDetailed<ThingsListResult>(
      "/api/things?limit=1000&sort=title&order=asc",
      { revalidate: 60 }
    ),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!itemsResult.ok) return itemsResult;

  return {
    ok: true,
    data: {
      stats: statsResult.data,
      items: itemsResult.data.things,
      total: itemsResult.data.total,
    },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: { total: 0, byType: {}, byVerdict: {}, byEntityType: {} },
    items: [],
    total: 0,
  };
}

// ── Stats Card ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export async function ThingsContent() {
  const { data, source, apiError } = await withApiFallback(loadFromApi, emptyFallback);
  const { stats, items, total } = data;

  // Build a lookup map for parent chain resolution
  const thingMap = new Map<string, ThingsApiItem>();
  for (const item of items) {
    thingMap.set(item.id, item);
  }

  // Build rows with hrefs for all thing types
  const rows: ThingRow[] = items.map((item) => {
    const href = resolveThingHref(item);
    const parentEntity = resolveParentEntityHref(item, thingMap);

    return {
      id: item.id,
      thingType: item.thingType,
      title: item.title,
      parentThingId: item.parentThingId,
      parentTitle: parentEntity?.title,
      parentHref: parentEntity?.href,
      sourceTable: item.sourceTable,
      sourceId: item.sourceId,
      entityType: item.entityType,
      description: item.description,
      sourceUrl: item.sourceUrl,
      numericId: item.numericId,
      verdict: item.verdict,
      verdictConfidence: item.verdictConfidence,
      href,
    };
  });

  // Compute verdict stats
  const withVerdict = Object.entries(stats.byVerdict)
    .filter(([v]) => v !== "unverified")
    .reduce((sum, [, c]) => sum + c, 0);

  const wikiServerUrl = getWikiServerConfig()?.serverUrl || "";

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Things" value={stats.total.toLocaleString()} />
        <StatCard
          label="Types"
          value={Object.keys(stats.byType).length}
          sub={Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ")}
        />
        <StatCard
          label="With Verdicts"
          value={withVerdict}
          sub={
            stats.total > 0
              ? `${((withVerdict / stats.total) * 100).toFixed(1)}% of total`
              : undefined
          }
        />
        <StatCard
          label="Entity Types"
          value={Object.keys(stats.byEntityType).length}
          sub={Object.entries(stats.byEntityType)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ")}
        />
      </div>

      {/* Type breakdown */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">By Type</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <div
                key={type}
                className="bg-card border rounded-md px-3 py-2 text-sm"
              >
                <span className="font-medium">{type}</span>
                <span className="text-muted-foreground ml-2">
                  {count.toLocaleString()}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Verdict breakdown */}
      {Object.keys(stats.byVerdict).length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Verification Status</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byVerdict)
              .sort(([, a], [, b]) => b - a)
              .map(([verdict, count]) => (
                <div
                  key={verdict}
                  className="bg-card border rounded-md px-3 py-2 text-sm"
                >
                  <span className="font-medium">{verdict}</span>
                  <span className="text-muted-foreground ml-2">
                    {count.toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Things table */}
      <div>
        <h2 className="text-lg font-semibold mb-3">
          All Things{" "}
          <span className="text-muted-foreground font-normal">
            ({total > items.length ? `showing ${items.length.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()})
          </span>
        </h2>
        <ThingsTable data={rows} wikiServerUrl={wikiServerUrl} />
      </div>
    </>
  );
}
