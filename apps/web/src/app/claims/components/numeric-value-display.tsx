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

/**
 * Map measure/property IDs to display units for formatting.
 * Source of truth: data/fact-measures.yaml (measures + propertyAliases).
 * This map includes both kebab-case measure IDs and snake_case claim property IDs.
 */
function resolveUnit(measure?: string | null, unit?: string | null): string | null {
  if (unit) return unit;
  if (!measure) return null;
  const unitMap: Record<string, string> = {
    // Financial (measures, kebab-case)
    revenue: "USD",
    valuation: "USD",
    "funding-round": "USD",
    "total-funding": "USD",
    "cash-burn": "USD",
    "product-revenue": "USD",
    "revenue-guidance": "USD",
    "infrastructure-investment": "USD",
    "net-worth": "USD",
    "equity-value": "USD",
    "philanthropic-capital": "USD",
    "market-volume": "USD",
    // Financial (claim property aliases, snake_case)
    funding_round_amount: "USD",
    funding_total: "USD",
    market_volume: "USD",
    // Organizational — count
    headcount: "count",
    "customer-count": "count",
    "user-count": "count",
    employee_count: "count",
    // Technical — count
    "model-parameters": "count",
    "safety-researcher-count": "count",
    "interpretability-team-size": "count",
    parameter_count: "count",
    // Percentages
    "market-share": "percent",
    "gross-margin": "percent",
    "safety-staffing-ratio": "percent",
    "equity-stake-percent": "percent",
    "customer-concentration": "percent",
    "retention-rate": "percent",
    "compute-cost": "percent",
    "benchmark-score": "percent",
    market_share: "percent",
    benchmark_score: "percent",
    // Technical
    "context-window": "tokens",
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
