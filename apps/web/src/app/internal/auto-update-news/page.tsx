import fs from "fs";
import path from "path";
import { loadYaml } from "@lib/yaml";
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { NewsTable } from "./news-table";
import { SourcesTable } from "./sources-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Auto-Update News | Longterm Wiki Internal",
  description:
    "Browse news items found by the auto-update system and see how they were routed to wiki pages.",
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface DigestItem {
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string;
  summary: string;
  relevanceScore: number;
  topics: string[];
  entities: string[];
}

interface PageUpdate {
  pageId: string;
  pageTitle: string;
  reason: string;
  suggestedTier: string;
  relevantNews: Array<{ title: string; url: string; summary: string }>;
  directions: string;
}

interface NewPageSuggestion {
  suggestedTitle: string;
  suggestedId: string;
  reason: string;
  relevantNews: Array<{ title: string; url: string }>;
  suggestedTier: string;
}

interface RunDetails {
  digest: {
    date: string;
    itemCount: number;
    items: DigestItem[];
    fetchedSources: string[];
    failedSources: string[];
  };
  plan: {
    date: string;
    pageUpdates: PageUpdate[];
    newPageSuggestions: NewPageSuggestion[];
    skippedReasons: Array<{ item: string; reason: string }>;
    estimatedCost: number;
  };
}

export interface NewsRow {
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string;
  summary: string;
  relevanceScore: number;
  topics: string[];
  routedTo: string | null;
  routedTier: string | null;
  runDate: string;
}

interface NewsSource {
  id: string;
  name: string;
  type: string;
  url?: string;
  query?: string;
  frequency: string;
  categories: string[];
  reliability: string;
  enabled: boolean;
}

export interface SourceRow {
  id: string;
  name: string;
  type: string;
  frequency: string;
  categories: string;
  reliability: string;
  enabled: boolean;
  lastFetched: string | null;
}

// ── API Types ────────────────────────────────────────────────────────────

interface ApiNewsItem {
  id: number;
  runId: number;
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string | null;
  summary: string | null;
  relevanceScore: number | null;
  topics: string[];
  entities: string[];
  routedToPageId: string | null;
  routedToPageTitle: string | null;
  routedTier: string | null;
  runDate: string | null;
}

// ── API Data Loading ─────────────────────────────────────────────────────

type NewsData = { items: NewsRow[]; runDates: string[] };

async function loadNewsItemsFromApi(): Promise<FetchResult<NewsData>> {
  const result = await fetchDetailed<{
    items: ApiNewsItem[];
    runDates: string[];
  }>("/api/auto-update-news/dashboard?runs=10", { revalidate: 60 });

  if (!result.ok) return result;

  return {
    ok: true,
    data: {
      items: result.data.items.map((item) => ({
        title: item.title,
        url: item.url,
        sourceId: item.sourceId,
        publishedAt: item.publishedAt ?? "",
        summary: item.summary ?? "",
        relevanceScore: item.relevanceScore ?? 0,
        topics: item.topics ?? [],
        routedTo: item.routedToPageTitle ?? null,
        routedTier: item.routedTier ?? null,
        runDate: item.runDate ?? "",
      })),
      runDates: result.data.runDates,
    },
  };
}

// ── YAML Fallback ────────────────────────────────────────────────────────

function loadNewsItemsFromYaml(): { items: NewsRow[]; runDates: string[] } {
  const runsDir = path.resolve(process.cwd(), "../../data/auto-update/runs");
  if (!fs.existsSync(runsDir)) return { items: [], runDates: [] };

  // Find detail files (most recent first)
  const detailFiles = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith("-details.yaml"))
    .sort()
    .reverse()
    .slice(0, 10); // Last 10 runs

  const allItems: NewsRow[] = [];
  const runDates: string[] = [];

  for (const file of detailFiles) {
    try {
      const raw = fs.readFileSync(path.join(runsDir, file), "utf-8");
      const details = loadYaml<RunDetails>(raw);
      const runDate = details.digest.date;
      runDates.push(runDate);

      // Build routing lookup: news title → page it was routed to
      const routingMap = new Map<string, { pageTitle: string; tier: string }>();
      for (const update of details.plan.pageUpdates) {
        for (const news of update.relevantNews) {
          routingMap.set(news.title, {
            pageTitle: update.pageTitle,
            tier: update.suggestedTier,
          });
        }
      }

      for (const item of details.digest.items) {
        const routing = routingMap.get(item.title);
        allItems.push({
          title: item.title,
          url: item.url,
          sourceId: item.sourceId,
          publishedAt: item.publishedAt,
          summary: item.summary,
          relevanceScore: item.relevanceScore,
          topics: Array.isArray(item.topics) ? item.topics : [],
          routedTo: routing?.pageTitle || null,
          routedTier: routing?.tier || null,
          runDate,
        });
      }
    } catch {
      /* skip malformed files */
    }
  }

  return { items: allItems, runDates: [...new Set(runDates)] };
}

// ── Sources Loading ──────────────────────────────────────────────────────

function loadSources(): SourceRow[] {
  const sourcesPath = path.resolve(
    process.cwd(),
    "../../data/auto-update/sources.yaml"
  );
  const statePath = path.resolve(
    process.cwd(),
    "../../data/auto-update/state.yaml"
  );

  if (!fs.existsSync(sourcesPath)) return [];

  try {
    const raw = fs.readFileSync(sourcesPath, "utf-8");
    const config = loadYaml<{ sources: NewsSource[] }>(raw);

    let fetchTimes: Record<string, string> = {};
    if (fs.existsSync(statePath)) {
      try {
        const stateRaw = fs.readFileSync(statePath, "utf-8");
        const state = loadYaml<{
          last_fetch_times?: Record<string, string>;
        }>(stateRaw);
        fetchTimes = state?.last_fetch_times || {};
      } catch {
        /* ignore */
      }
    }

    return config.sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      frequency: s.frequency,
      categories: s.categories.join(", "),
      reliability: s.reliability,
      enabled: s.enabled,
      lastFetched: fetchTimes[s.id] ?? null,
    }));
  } catch {
    return [];
  }
}

// ── Page Component ─────────────────────────────────────────────────────────

export default async function AutoUpdateNewsPage() {
  // Try API first, fall back to YAML
  const { data: newsData, source, apiError } = await withApiFallback(
    loadNewsItemsFromApi,
    loadNewsItemsFromYaml
  );
  const { items, runDates } = newsData;
  const sources = loadSources();

  const routedCount = items.filter((i) => i.routedTo).length;
  const highRelevance = items.filter((i) => i.relevanceScore >= 70).length;
  const sourceCounts = new Map<string, number>();
  for (const item of items) {
    sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) || 0) + 1);
  }

  return (
    <article className="prose max-w-none">
      <h1>Auto-Update News</h1>
      <p className="text-muted-foreground">
        News items discovered by the auto-update pipeline and how they were
        routed to wiki pages.{" "}
        {items.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{items.length}</span>{" "}
            items across {runDates.length} run{runDates.length !== 1 && "s"},{" "}
            <span className="font-medium text-foreground">{highRelevance}</span>{" "}
            high-relevance,{" "}
            <span className="font-medium text-foreground">{routedCount}</span>{" "}
            routed to pages.
          </>
        ) : (
          <>
            No news data yet. Run{" "}
            <code className="text-xs">pnpm crux auto-update run</code> to
            populate.
          </>
        )}
      </p>

      <DataSourceBanner source={source} apiError={apiError} />

      {items.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No news items yet</p>
          <p className="text-sm">
            Once the auto-update pipeline runs, discovered news items will
            appear here with their relevance scores and routing decisions.
          </p>
          <p className="text-sm mt-2">
            Try a dry run:{" "}
            <code className="text-xs">
              pnpm crux auto-update run --dry-run
            </code>
          </p>
        </div>
      ) : (
        <>
          <h2>News Items</h2>
          <NewsTable data={items} />
        </>
      )}

      <h2>Configured Sources</h2>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{sources.length}</span>{" "}
        sources configured (
        {sources.filter((s) => s.enabled).length} enabled). Edit{" "}
        <code className="text-xs">data/auto-update/sources.yaml</code> to
        change.
      </p>
      {sources.length > 0 && <SourcesTable data={sources} />}
    </article>
  );
}
