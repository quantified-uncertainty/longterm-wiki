import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getEntityHref } from "@/data";
import { CoverageTable, type CoverageRow } from "./coverage-table";

// ── Types (match the wiki-server scanner-results route response shapes) ──

interface ScannerResultItem {
  id: number;
  scanRunId: string;
  recordType: string;
  entityId: string;
  entityName: string;
  entityType: string;
  totalRecords: number;
  verifiedRecords: number;
  completenessPct: number;
  missingFields: string[];
  entityImportance: number | null;
  scannedAt: string;
  createdAt: string;
}

interface LatestResponse {
  items: ScannerResultItem[];
  total: number;
  scanRunId: string | null;
}

interface TrendRun {
  scanRunId: string;
  scannedAt: string;
  totalItems: number;
  avgCompleteness: number;
  totalRecordsSum: number;
}

interface TrendsResponse {
  runs: TrendRun[];
  entityTrends: Array<{
    scanRunId: string;
    completenessPct: number;
    totalRecords: number;
    scannedAt: string;
  }>;
}

interface DashboardData {
  items: ScannerResultItem[];
  total: number;
  scanRunId: string | null;
  trendRuns: TrendRun[];
}

// ── Data Loading ────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [latestResult, trendsResult] = await Promise.all([
    fetchDetailed<LatestResponse>("/api/scanner-results/latest?limit=500", {
      revalidate: 60,
    }),
    fetchDetailed<TrendsResponse>("/api/scanner-results/trends?limit=10", {
      revalidate: 60,
    }),
  ]);

  const items = latestResult.ok ? latestResult.data.items : [];
  const total = latestResult.ok ? latestResult.data.total : 0;
  const scanRunId = latestResult.ok ? latestResult.data.scanRunId : null;
  const trendRuns = trendsResult.ok ? trendsResult.data.runs : [];

  if (!latestResult.ok && !trendsResult.ok) {
    return latestResult;
  }

  return { ok: true, data: { items, total, scanRunId, trendRuns } };
}

function emptyFallback(): DashboardData {
  return { items: [], total: 0, scanRunId: null, trendRuns: [] };
}

// ── Stats computation ────────────────────────────────────────────────

interface RecordTypeStats {
  recordType: string;
  entityCount: number;
  totalRecords: number;
  avgCompleteness: number;
  /** Count of entities by completeness tier */
  byTier: { stub: number; basic: number; moderate: number; comprehensive: number };
}

function completenessTier(pct: number): "stub" | "basic" | "moderate" | "comprehensive" {
  if (pct >= 75) return "comprehensive";
  if (pct >= 50) return "moderate";
  if (pct >= 25) return "basic";
  return "stub";
}

function computeRecordTypeStats(items: ScannerResultItem[]): RecordTypeStats[] {
  const byType = new Map<string, {
    entityCount: number;
    totalRecords: number;
    completenessSum: number;
    byTier: { stub: number; basic: number; moderate: number; comprehensive: number };
  }>();

  for (const item of items) {
    const existing = byType.get(item.recordType) ?? {
      entityCount: 0,
      totalRecords: 0,
      completenessSum: 0,
      byTier: { stub: 0, basic: 0, moderate: 0, comprehensive: 0 },
    };
    existing.entityCount += 1;
    existing.totalRecords += item.totalRecords;
    existing.completenessSum += item.completenessPct;
    existing.byTier[completenessTier(item.completenessPct)] += 1;
    byType.set(item.recordType, existing);
  }

  const result: RecordTypeStats[] = [];
  for (const [recordType, data] of byType) {
    result.push({
      recordType,
      entityCount: data.entityCount,
      totalRecords: data.totalRecords,
      avgCompleteness: data.entityCount > 0
        ? Math.round((data.completenessSum / data.entityCount) * 10) / 10
        : 0,
      byTier: data.byTier,
    });
  }

  result.sort((a, b) => b.entityCount - a.entityCount);
  return result;
}

// ── Completeness Bar ────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  stub: "bg-red-500 dark:bg-red-600",
  basic: "bg-amber-400 dark:bg-amber-500",
  moderate: "bg-blue-500 dark:bg-blue-500",
  comprehensive: "bg-emerald-500 dark:bg-emerald-500",
};

const TIER_LABELS: Record<string, string> = {
  stub: "<25%",
  basic: "25-49%",
  moderate: "50-74%",
  comprehensive: "75%+",
};

function CompletenessBar({ stats }: { stats: RecordTypeStats }) {
  const { entityCount, byTier } = stats;
  if (entityCount === 0) return null;

  const tiers = ["stub", "basic", "moderate", "comprehensive"] as const;

  return (
    <div className="flex h-5 w-full rounded-md overflow-hidden">
      {tiers.map((tier) => {
        const count = byTier[tier];
        if (count === 0) return null;
        return (
          <div
            key={tier}
            className={`${TIER_COLORS[tier]} flex items-center justify-center text-[10px] font-medium text-white`}
            style={{ width: `${(count / entityCount) * 100}%` }}
            title={`${TIER_LABELS[tier]}: ${count} entities (${((count / entityCount) * 100).toFixed(1)}%)`}
          >
            {(count / entityCount) * 100 >= 8 ? count : ""}
          </div>
        );
      })}
    </div>
  );
}

// ── Trend Indicator ────────────────────────────────────────────────

function TrendIndicator({ runs }: { runs: TrendRun[] }) {
  if (runs.length < 2) return null;

  const latest = runs[0];
  const previous = runs[1];
  const diff = latest.avgCompleteness - previous.avgCompleteness;

  if (Math.abs(diff) < 0.5) {
    return <span className="text-xs text-muted-foreground">flat</span>;
  }

  return diff > 0 ? (
    <span className="text-xs text-emerald-600 dark:text-emerald-400">
      +{diff.toFixed(1)}%
    </span>
  ) : (
    <span className="text-xs text-red-600 dark:text-red-400">
      {diff.toFixed(1)}%
    </span>
  );
}

// ── Content Component ────────────────────────────────────────────────

export async function TablebaseCoverageContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );

  const { items, scanRunId, trendRuns } = data;
  const typeStats = computeRecordTypeStats(items);

  // Compute global summary
  const totalEntities = items.length;
  const globalAvgCompleteness = totalEntities > 0
    ? Math.round(items.reduce((s, i) => s + i.completenessPct, 0) / totalEntities * 10) / 10
    : 0;
  const totalRecords = items.reduce((s, i) => s + i.totalRecords, 0);
  const totalVerified = items.reduce((s, i) => s + i.verifiedRecords, 0);

  // Transform items for enrichment queue table
  const rows: CoverageRow[] = items.map((item) => ({
    entityId: item.entityId,
    entityName: item.entityName,
    entityType: item.entityType,
    recordType: item.recordType,
    totalRecords: item.totalRecords,
    verifiedRecords: item.verifiedRecords,
    completenessPct: item.completenessPct,
    missingFields: item.missingFields,
    entityImportance: item.entityImportance,
    scannedAt: item.scannedAt,
    href: getEntityHref(item.entityId),
  }));

  const recordTypes = [...new Set(rows.map((r) => r.recordType))].sort();
  const entityTypes = [...new Set(rows.map((r) => r.entityType))].sort();

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed">
        Coverage analysis for {totalEntities.toLocaleString()} entity-record-type
        pairs across {typeStats.length} record types, from scan run{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">
          {scanRunId ?? "none"}
        </code>
        . Use the enrichment queue below to prioritize data enrichment.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 my-6">
        <StatCard label="Entities Scanned" value={totalEntities.toLocaleString()} />
        <StatCard label="Avg Completeness" value={`${globalAvgCompleteness}%`}>
          <TrendIndicator runs={trendRuns} />
        </StatCard>
        <StatCard label="Total Records" value={totalRecords.toLocaleString()} />
        <StatCard label="Verified Records" value={totalVerified.toLocaleString()} />
        <StatCard label="Record Types" value={typeStats.length.toLocaleString()} />
      </div>

      {/* Completeness tier legend */}
      <div className="flex flex-wrap gap-4 mb-6">
        {(["stub", "basic", "moderate", "comprehensive"] as const).map((tier) => {
          const count = items.filter((i) => completenessTier(i.completenessPct) === tier).length;
          return (
            <div key={tier} className="flex items-center gap-1.5">
              <div className={`h-3 w-3 rounded-sm ${TIER_COLORS[tier]}`} />
              <span className="text-xs text-muted-foreground">
                {TIER_LABELS[tier]} ({count.toLocaleString()})
              </span>
            </div>
          );
        })}
      </div>

      {/* Coverage by record type */}
      {typeStats.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Coverage by Record Type</h2>
          <div className="space-y-3">
            {typeStats.map((ts) => (
              <div key={ts.recordType}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{ts.recordType}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ts.entityCount} entities, {ts.totalRecords.toLocaleString()} records, avg {ts.avgCompleteness}%
                  </span>
                </div>
                <CompletenessBar stats={ts} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scan history (trends) */}
      {trendRuns.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Scan History</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-medium">Scan Run</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium text-right">Items</th>
                  <th className="py-2 pr-4 font-medium text-right">Avg Completeness</th>
                  <th className="py-2 font-medium text-right">Total Records</th>
                </tr>
              </thead>
              <tbody>
                {trendRuns.map((run) => (
                  <tr key={run.scanRunId} className="border-b border-border/50">
                    <td className="py-2 pr-4">
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">
                        {run.scanRunId.length > 20
                          ? `${run.scanRunId.slice(0, 20)}...`
                          : run.scanRunId}
                      </code>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground tabular-nums">
                      {new Date(run.scannedAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {run.totalItems.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {run.avgCompleteness}%
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {run.totalRecordsSum.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Enrichment queue */}
      {rows.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-1">Enrichment Queue</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Entities ranked by lowest completeness. Use this to prioritize data
            enrichment work.
          </p>
          <CoverageTable
            data={rows}
            recordTypes={recordTypes}
            entityTypes={entityTypes}
          />
        </div>
      )}

      {totalEntities === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No scanner results yet</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              pnpm crux tb scan --persist
            </code>{" "}
            to compute and persist coverage data.
          </p>
        </div>
      )}
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {children}
      </div>
    </div>
  );
}
