/**
 * Data Sources tab content for the /sources page.
 * Fetches data sources from the wiki-server API and renders
 * stat cards + sortable table within a tab panel.
 */
import {
  fetchDetailed,
  type RpcDataSourceListResult,
} from "@/lib/wiki-server";
import { DataSourceBanner } from "@/components/internal/DataSourceBanner";
import { DataSourcesTable } from "@/app/data-sources/data-sources-table";
import { enrichDataSources, StatCard } from "@/app/data-sources/data-sources-shared";

export async function DataSourcesTabContent() {
  const result = await fetchDetailed<RpcDataSourceListResult>(
    "/api/data-sources",
    { revalidate: 60 },
  );

  if (!result.ok) {
    return (
      <div className="py-4">
        <DataSourceBanner source="api" apiError={result.error} />
        <p className="text-destructive text-sm mt-2">
          Failed to load data sources.{" "}
          {result.error.type === "not-configured"
            ? "Wiki server not configured."
            : result.error.type === "connection-error"
              ? result.error.message
              : `Server error: ${result.error.status}`}
        </p>
      </div>
    );
  }

  const raw = result.data.dataSources;

  if (raw.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
        <p className="text-lg font-medium mb-2">No data sources registered</p>
        <p className="text-sm">
          Run{" "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
            pnpm crux tb data-sources snapshot --all
          </code>{" "}
          to sync source metadata from manifests.
        </p>
      </div>
    );
  }

  const rows = enrichDataSources(raw);
  const staleSources = rows.filter((r) => r.freshness === "overdue").length;
  const activeSources = rows.filter((r) => r.sourceStatus === "active").length;
  const totalRecords = rows.reduce(
    (sum, r) => sum + (r.snapshotRecordCount ?? 0),
    0,
  );

  return (
    <div>
      <p className="text-muted-foreground text-sm leading-relaxed mb-4">
        Structured data feeds (CSV, JSON, HTML) for grants, personnel, and
        investments — tracked with versioned snapshots.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Active Sources"
          value={activeSources}
          sub={`${rows.length} total`}
        />
        <StatCard
          label="Stale Sources"
          value={staleSources}
          color={staleSources > 0 ? "text-red-600" : "text-emerald-600"}
          sub={staleSources > 0 ? "overdue for refresh" : "all on schedule"}
        />
        <StatCard
          label="Records Tracked"
          value={totalRecords.toLocaleString()}
        />
        <StatCard
          label="Static Sources"
          value={rows.filter((r) => r.freshness === "static").length}
          sub="historical, not refreshed"
        />
      </div>

      <DataSourcesTable rows={rows} />
    </div>
  );
}
