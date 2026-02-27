import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { CitationContentTable } from "./citation-content-table";
import type {
  CitationContentListEntry,
  CitationContentListResult,
  CitationContentStatsResult,
} from "@wiki-server/api-response-types";

/** Backward-compatible alias — the table component imports this name. */
export type ContentEntry = CitationContentListEntry;

async function loadContentFromApi(): Promise<FetchResult<{ entries: ContentEntry[]; stats: CitationContentStatsResult }>> {
  const [listResult, statsResult] = await Promise.all([
    fetchDetailed<CitationContentListResult>("/api/citations/content/list?limit=5000", {
      revalidate: 120,
    }),
    fetchDetailed<CitationContentStatsResult>("/api/citations/content/stats", {
      revalidate: 120,
    }),
  ]);

  if (!listResult.ok) return { ok: false, error: listResult.error };

  const stats: CitationContentStatsResult = statsResult.ok
    ? statsResult.data
    : {
        total: listResult.data.total,
        withFullText: listResult.data.withFullText,
        withPreview: listResult.data.withPreview,
        coverage:
          listResult.data.total > 0
            ? Math.round(
                (listResult.data.withFullText / listResult.data.total) * 100
              )
            : 0,
        okCount: 0,
        deadCount: 0,
        avgContentLength: null,
      };

  return {
    ok: true,
    data: {
      entries: listResult.data.entries,
      stats,
    },
  };
}

function emptyData() {
  return {
    entries: [] as ContentEntry[],
    stats: {
      total: 0,
      withFullText: 0,
      withPreview: 0,
      coverage: 0,
      okCount: 0,
      deadCount: 0,
      avgContentLength: null,
    } as CitationContentStatsResult,
  };
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export async function CitationContentContent() {
  const { data, source, apiError } = await withApiFallback(
    loadContentFromApi,
    emptyData
  );

  const { entries, stats } = data ?? emptyData();

  return (
    <>
      <p className="text-muted-foreground">
        Full-text content fetched from citation URLs, stored durably in
        PostgreSQL.{" "}
        {stats.total > 0 ? (
          <>
            <span className="font-medium text-foreground">{stats.total}</span>{" "}
            URLs stored,{" "}
            <span className="font-medium text-foreground">
              {stats.withFullText}
            </span>{" "}
            with full text ({stats.coverage}% coverage).
            {stats.deadCount > 0 && (
              <span className="text-red-500 font-medium ml-1">
                {stats.deadCount} dead links.
              </span>
            )}
          </>
        ) : (
          <>
            No content stored yet. Run{" "}
            <code className="text-xs">pnpm crux citations verify --all</code>{" "}
            to populate.
          </>
        )}
      </p>

      {stats.total > 0 && (
        <div className="not-prose grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total URLs" value={stats.total} />
          <StatCard
            label="Full Text"
            value={`${stats.withFullText} (${stats.coverage}%)`}
          />
          <StatCard label="Live (2xx)" value={stats.okCount} />
          <StatCard
            label="Avg Size"
            value={
              stats.avgContentLength
                ? `${Math.round(stats.avgContentLength / 1000)}KB`
                : "—"
            }
          />
        </div>
      )}

      {entries.length > 0 && stats.total > entries.length && (
        <p className="text-sm text-muted-foreground mb-4">
          Showing {entries.length.toLocaleString()} of {stats.total.toLocaleString()} entries.
        </p>
      )}

      {entries.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No citation content stored</p>
          <p className="text-sm">
            Citation content is stored automatically when citations are verified.
            Run{" "}
            <code className="text-xs">pnpm crux citations verify --all</code>{" "}
            to populate.
          </p>
        </div>
      ) : (
        <CitationContentTable data={entries} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
