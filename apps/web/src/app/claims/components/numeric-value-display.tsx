/**
 * NumericValueDisplay — renders a numeric claim value with optional range.
 * Formats large numbers using compact notation (1B, 750M, etc.)
 */

interface Props {
  value: number | null;
  low?: number | null;
  high?: number | null;
  measure?: string | null;
  compact?: boolean;
}

function formatNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1).replace(/\.0$/, "")}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  if (abs < 1 && abs > 0) return `${(n * 100).toFixed(1)}%`;
  return n.toLocaleString();
}

export function NumericValueDisplay({ value, low, high, measure, compact }: Props) {
  if (value == null && low == null && high == null) return null;

  const central = value != null ? formatNum(value) : null;
  const range =
    low != null && high != null
      ? `${formatNum(low)} – ${formatNum(high)}`
      : null;

  const measureLabel = measure
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
