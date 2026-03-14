/**
 * Charts section for organization profile pages.
 * Renders time-series and breakdown charts from KB fact data.
 * Only shows charts where sufficient data exists (≥2 data points).
 */
import { SectionHeader } from "./org-shared";
import type { ChartDataBundle } from "./org-data";
import {
  TimeSeriesChart,
  EquityBreakdownChart,
} from "./org-charts";

export function ChartsSection({
  chartData,
  orgName,
}: {
  chartData: ChartDataBundle;
  orgName: string;
}) {
  const { valuationSeries, revenueSeries, headcountSeries, equityHolders, latestValuation, fundingAnnotations } = chartData;

  const hasValuation = valuationSeries.length >= 2;
  const hasRevenue = revenueSeries.length >= 2;
  const hasHeadcount = headcountSeries.length >= 2;
  const hasEquity = equityHolders.length >= 2;

  if (!hasValuation && !hasRevenue && !hasHeadcount && !hasEquity) return null;

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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
              title={`Equity Breakdown${latestValuation ? "" : ""}`}
            />
          )}
        </div>
      )}
    </section>
  );
}
