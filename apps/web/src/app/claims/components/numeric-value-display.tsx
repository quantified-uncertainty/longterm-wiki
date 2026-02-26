/**
 * NumericValueDisplay — renders a numeric claim value with optional range.
 * Uses the shared formatValue utility for consistent formatting.
 */

import { formatValue } from "@lib/format-value";

interface Props {
  value: number | null;
  low?: number | null;
  high?: number | null;
  measure?: string | null;
  unit?: string | null;
  compact?: boolean;
}

/** Map measure IDs to display units for formatting. */
function resolveUnit(measure?: string | null, unit?: string | null): string | null {
  if (unit) return unit;
  if (!measure) return null;
  // Common measure-to-unit mappings based on claims-properties.yaml and fact-measures.yaml
  const unitMap: Record<string, string> = {
    revenue: "USD",
    valuation: "USD",
    funding_round_amount: "USD",
    funding_total: "USD",
    "funding-round": "USD",
    "total-funding": "USD",
    "cash-burn": "USD",
    "product-revenue": "USD",
    "revenue-guidance": "USD",
    "infrastructure-investment": "USD",
    "net-worth": "USD",
    "equity-value": "USD",
    "philanthropic-capital": "USD",
    market_volume: "USD",
    employee_count: "count",
    headcount: "count",
    "customer-count": "count",
    "user-count": "count",
    parameter_count: "count",
    "model-parameters": "count",
    "safety-researcher-count": "count",
    "interpretability-team-size": "count",
    market_share: "percent",
    "market-share": "percent",
    "gross-margin": "percent",
    "safety-staffing-ratio": "percent",
    "equity-stake-percent": "percent",
    "customer-concentration": "percent",
    "retention-rate": "percent",
    "compute-cost": "percent",
    "benchmark-score": "percent",
    benchmark_score: "percent",
    context_window: "tokens",
  };
  return unitMap[measure] ?? null;
}

function formatNum(n: number, displayUnit: string | null): string {
  return formatValue(n, displayUnit);
}

export function NumericValueDisplay({ value, low, high, measure, unit, compact }: Props) {
  if (value == null && low == null && high == null) return null;

  const displayUnit = resolveUnit(measure, unit);
  const central = value != null ? formatNum(value, displayUnit) : null;
  const range =
    low != null && high != null
      ? `${formatNum(low, displayUnit)} \u2013 ${formatNum(high, displayUnit)}`
      : null;

  const measureLabel = !displayUnit && measure
    ? measure.replace(/_/g, " ")
    : null;

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-sm">
        {central ?? range}
        {measureLabel && (
          <span className="text-emerald-500 font-normal">{measureLabel}</span>
        )}
      </span>
    );
  }

  return (
    <div className="text-sm">
      {central && (
        <span className="font-mono font-medium text-emerald-700">{central}</span>
      )}
      {range && (
        <span className="font-mono text-emerald-600 ml-1 text-xs">({range})</span>
      )}
      {measureLabel && (
        <span className="text-muted-foreground ml-1.5 text-xs">{measureLabel}</span>
      )}
    </div>
  );
}
