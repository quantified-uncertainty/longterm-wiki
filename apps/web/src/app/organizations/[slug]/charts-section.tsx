/**
 * Charts section for organization profile pages.
 * Renders time-series and breakdown charts from KB fact data.
 * Only shows charts where sufficient data exists (≥2 data points).
 */
import { SectionHeader } from "./org-shared";
import type { ChartDataBundle, ParsedDilutionStageRecord } from "./org-data";
import {
  TimeSeriesChart,
  EquityBreakdownChart,
  DilutionWaterfallChart,
  FundingTimelineChart,
  MarketShareChart,
} from "./org-charts";

export function ChartsSection({
  chartData,
  orgName,
  dilutionStages,
}: {
  chartData: ChartDataBundle;
  orgName: string;
  dilutionStages?: ParsedDilutionStageRecord[];
}) {
  const { valuationSeries, revenueSeries, headcountSeries, equityHolders, latestValuation, fundingAnnotations, fundingTimelineSeries, marketShareGroups } = chartData;

  const hasValuation = valuationSeries.length >= 2;
  const hasRevenue = revenueSeries.length >= 2;
  const hasHeadcount = headcountSeries.length >= 2;
  const hasEquity = equityHolders.length >= 2;
  const hasDilution = (dilutionStages?.length ?? 0) >= 2;
  const hasFundingTimeline = fundingTimelineSeries.length >= 2;
  const hasMarketShare = marketShareGroups.length > 0;

  if (!hasValuation && !hasRevenue && !hasHeadcount && !hasEquity && !hasDilution && !hasFundingTimeline && !hasMarketShare) return null;

  // Build valuation annotations from funding rounds
  const valuationAnnotations = fundingAnnotations
    .filter((a) => a.valuation)
    .map((a) => ({ date: a.date, label: a.label }));

  return (
    <section>
      <SectionHeader title="Key Metrics" />

      {/* Row 1: Valuation + Revenue side by side */}
      {(hasValuation || hasRevenue) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {hasValuation && (
            <TimeSeriesChart
              title="Valuation"
              series={[{
                data: valuationSeries,
                label: "Post-money valuation",
                color: "var(--color-chart-1, #ef4444)",
                fillColor: "var(--color-chart-1, #ef4444)",
              }]}
              format="currency"
              showLabels={true}
              annotations={valuationAnnotations}
            />
          )}
          {hasRevenue && (
            <TimeSeriesChart
              title="Revenue (ARR)"
              series={[{
                data: revenueSeries,
                label: "Annual run rate",
                color: "var(--color-chart-2, #22c55e)",
                fillColor: "var(--color-chart-2, #22c55e)",
              }]}
              format="currency"
              showLabels={false}
            />
          )}
        </div>
      )}

      {/* Row 2: Headcount + Equity side by side */}
      {(hasHeadcount || hasEquity) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {hasHeadcount && (
            <TimeSeriesChart
              title="Headcount"
              series={[{
                data: headcountSeries,
                label: "Employees",
                color: "var(--color-chart-3, #6366f1)",
                fillColor: "var(--color-chart-3, #6366f1)",
              }]}
              format="number"
              showLabels={false}
            />
          )}
          {hasEquity && (
            <EquityBreakdownChart
              holders={equityHolders}
              valuation={latestValuation ?? undefined}
              title="Equity Breakdown"
            />
          )}
        </div>
      )}

      {/* Row 3: Funding timeline + Dilution waterfall */}
      {(hasFundingTimeline || hasDilution) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {hasFundingTimeline && (
            <FundingTimelineChart
              data={fundingTimelineSeries}
              title="Funding Rounds"
            />
          )}
          {hasDilution && dilutionStages && (
            <DilutionWaterfallChart
              stages={dilutionStages.map((s) => ({
                round: s.round,
                date: s.date ?? "",
                foundersPercent: s.foundersPercent,
                employeesPercent: s.employeesPercent,
                investorsPercent: s.investorsPercent,
                valuation: s.valuation,
              }))}
              title="Ownership Dilution Over Time"
            />
          )}
        </div>
      )}

      {/* Row 4: Market share charts */}
      {hasMarketShare && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {marketShareGroups.map((group) => (
            <MarketShareChart
              key={group.propertyId}
              data={group.entries.map((e) => ({
                company: e.company,
                share: e.share,
                color: e.color,
              }))}
              title={group.title}
              subtitle={group.asOf ? `As of ${group.asOf}` : undefined}
              currentEntity={orgName}
            />
          ))}
        </div>
      )}
    </section>
  );
}
