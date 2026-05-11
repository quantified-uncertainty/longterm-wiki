import { Card, CardContent } from "@/components/ui/card";
import {
  fetchDetailed,
  type FetchResult,
  type RpcDataQualityHistoryResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { DataQualityTable } from "@/app/internal/data-quality/data-quality-table";
import { IdFormatSection } from "@/app/internal/data-quality/id-format-section";
import { ThingsSearchStatusSection } from "@/app/internal/data-quality/things-search-status";

function formatPercent(part: number, total: number): string {
  if (total === 0) return "N/A";
  return `${((part / total) * 100).toFixed(1)}%`;
}

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
    <Card className="p-4">
      <CardContent className="p-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export async function DataQualityContent() {
  const result: FetchResult<RpcDataQualityHistoryResult> =
    await fetchDetailed<RpcDataQualityHistoryResult>(
      "/api/data-quality/history?limit=100"
    );

  if (!result.ok) {
    const errorMsg =
      result.error.type === "not-configured"
        ? "Wiki server not configured"
        : result.error.type === "connection-error"
          ? result.error.message
          : `Server error: ${result.error.status}`;
    return (
      <div>
        <DataSourceBanner source="api" apiError={result.error} />
        <p className="text-destructive">
          Failed to load data quality snapshots: {errorMsg}
        </p>
      </div>
    );
  }

  const { snapshots, total } = result.data;

  if (snapshots.length === 0) {
    return (
      <div>
        <DataSourceBanner source="api" />
        <p className="text-muted-foreground">
          No snapshots yet. Run <code>crux sys quality snapshot</code> to
          capture one.
        </p>
      </div>
    );
  }

  const latest = snapshots[0];

  return (
    <div className="space-y-8">
      <DataSourceBanner source="api" />

      {/* Summary stats from latest snapshot */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Latest Snapshot{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({new Date(latest.capturedAt).toLocaleDateString()})
          </span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Source-Check Verdicts"
            value={latest.verdictsTotal}
            sub={`${formatPercent(latest.verdictsConfirmed, latest.verdictsTotal)} confirmed`}
          />
          <StatCard
            label="Personnel Records"
            value={latest.personnelTotal}
            sub={`${formatPercent(latest.personnelWithSource, latest.personnelTotal)} with source`}
          />
          <StatCard
            label="Grants"
            value={latest.grantsTotal}
            sub={`${formatPercent(latest.grantsWithSource, latest.grantsTotal)} with source`}
          />
          <StatCard
            label="Entities"
            value={latest.entitiesTotal}
            sub={`${formatPercent(latest.entitiesWithWikiPage, latest.entitiesTotal)} with wiki page`}
          />
          <StatCard
            label="Wiki Pages"
            value={latest.pagesTotal}
          />
          <StatCard
            label="FactBase Facts"
            value={latest.factbaseFacts}
            sub={`across ${latest.factbaseEntities} entities`}
          />
          <StatCard
            label="Investments"
            value={latest.investmentsTotal}
            sub={`${formatPercent(latest.investmentsWithSource, latest.investmentsTotal)} with source`}
          />
          <StatCard
            label="Funding Rounds"
            value={latest.fundingRoundsTotal}
          />
        </div>
      </section>

      {/* Verdict breakdown */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Verdict Breakdown</h2>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          <VerdictBadge label="Confirmed" count={latest.verdictsConfirmed} color="text-green-600" />
          <VerdictBadge label="Partial" count={latest.verdictsPartial} color="text-yellow-600" />
          <VerdictBadge label="Contradicted" count={latest.verdictsContradicted} color="text-red-600" />
          <VerdictBadge label="Outdated" count={latest.verdictsOutdated} color="text-orange-600" />
          <VerdictBadge label="Unverifiable" count={latest.verdictsUnverifiable} color="text-red-600" />
          <VerdictBadge label="Needs Recheck" count={latest.verdictsNeedsRecheck} color="text-blue-600" />
        </div>
      </section>

      {/* Claims pipeline */}
      {(() => {
        const extra = latest.extra as Record<string, number> | null;
        if (!extra || typeof extra !== "object" || !extra.claimsTotal) return null;
        return (
          <section>
            <h2 className="text-lg font-semibold mb-4">Claims Pipeline</h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              <StatCard label="Total Claims" value={extra.claimsTotal} />
              <StatCard label="Verified" value={extra.claimsVerified ?? 0} />
              <StatCard label="Contradicted" value={extra.claimsContradicted ?? 0} />
              <StatCard label="Pending" value={extra.claimsPending ?? 0} />
              <StatCard label="Unverifiable" value={extra.claimsUnverifiable ?? 0} />
              <StatCard label="Record Links" value={extra.claimRecordLinks ?? 0} />
            </div>
          </section>
        );
      })()}

      {/* things_search MV staleness (QUA-506 D5) */}
      <ThingsSearchStatusSection />

      {/* ID format audit (QUA-407 / QUA-439) */}
      <IdFormatSection snapshots={snapshots} />

      {/* History table */}
      <section>
        <h2 className="text-lg font-semibold mb-4">
          Snapshot History ({total} total)
        </h2>
        <DataQualityTable snapshots={snapshots} />
      </section>
    </div>
  );
}

function VerdictBadge({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <Card className="p-3 text-center">
      <CardContent className="p-0">
        <div className={`text-xl font-bold ${color}`}>{count}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
