import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
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

// ── Data Loading ──────────────────────────────────────────────────────────

const PAGE_SIZE = 200;

/** Fetch all items by paginating through the API in batches of PAGE_SIZE. */
async function fetchAllItems(): Promise<FetchResult<{ things: ThingsApiItem[]; total: number }>> {
  const allItems: ThingsApiItem[] = [];
  let offset = 0;
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await fetchDetailed<ThingsListResult>(
      `/api/things?limit=${PAGE_SIZE}&offset=${offset}&sort=title&order=asc`,
      { revalidate: 60 }
    );

    if (!result.ok) return result;

    allItems.push(...result.data.things);
    total = result.data.total;

    if (allItems.length >= total || result.data.things.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return { ok: true, data: { things: allItems, total } };
}

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, itemsResult] = await Promise.all([
    fetchDetailed<ThingsStatsResult>("/api/things/stats", { revalidate: 60 }),
    fetchAllItems(),
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

// ── Row Building ─────────────────────────────────────────────────────────

function buildHref(item: ThingsApiItem): string | undefined {
  if (item.thingType === "entity") {
    if (item.numericId) return `/wiki/${item.numericId}`;
    return getEntityHref(item.sourceId);
  }

  // Resources, grants, and everything else: link to sourceUrl if available
  if (item.sourceUrl) return item.sourceUrl;

  return undefined;
}

// ── Main Component ────────────────────────────────────────────────────────

export async function ThingsContent() {
  const { data, source, apiError } = await withApiFallback(loadFromApi, emptyFallback);
  const { stats, items } = data;

  const rows: ThingRow[] = items.map((item) => {
    const href = buildHref(item);
    const isExternal =
      item.thingType !== "entity" && !!href && href.startsWith("http");
    return {
      id: item.id,
      thingType: item.thingType,
      title: item.title,
      entityType: item.entityType,
      description: item.description,
      sourceUrl: item.sourceUrl,
      numericId: item.numericId,
      href,
      isExternal,
    };
  });

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
          label="Entity Types"
          value={Object.keys(stats.byEntityType).length}
          sub={Object.entries(stats.byEntityType)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ")}
        />
        <StatCard
          label="Items Loaded"
          value={items.length.toLocaleString()}
          sub={items.length === stats.total ? "all items" : `of ${stats.total.toLocaleString()}`}
        />
      </div>

      {/* Things table with type tabs */}
      <ThingsTable data={rows} typeCounts={stats.byType} />
    </>
  );
}
