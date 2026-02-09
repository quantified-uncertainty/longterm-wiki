/**
 * EstimatesPanel & EstimatesCard - Shows expert probability estimates
 *
 * Displays probability estimates from various sources with confidence intervals
 */

import React from "react";
import type { Estimate } from "@/data/parameter-graph-data";

interface EstimatesPanelProps {
  estimates: Estimate[];
  compact?: boolean;
}

function formatProbability(p: number): string {
  if (p < 0.01) return "<1%";
  if (p > 0.99) return ">99%";
  return `${Math.round(p * 100)}%`;
}

function formatConfidence(ci: [number, number]): string {
  return `${formatProbability(ci[0])} \u2013 ${formatProbability(ci[1])}`;
}

export function EstimatesPanel({
  estimates,
  compact = false,
}: EstimatesPanelProps) {
  if (!estimates || estimates.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        No probability estimates available
      </div>
    );
  }

  // Calculate aggregate statistics
  const probabilities = estimates.map((e) => e.probability);
  const sorted = [...probabilities].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean =
    probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  const min = Math.min(...probabilities);
  const max = Math.max(...probabilities);

  if (compact) {
    return (
      <div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">Estimates:</span>
          <span className="font-mono text-yellow-400">
            {formatProbability(median)}
          </span>
          <span className="text-muted-foreground">median</span>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-muted-foreground">
            range: {formatProbability(min)} \u2013 {formatProbability(max)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4 mb-4 p-3 bg-muted/50 rounded-lg">
        <div className="text-center">
          <div className="text-xs text-muted-foreground uppercase">Median</div>
          <div className="text-xl font-bold text-yellow-400">
            {formatProbability(median)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground uppercase">Mean</div>
          <div className="text-xl font-bold text-foreground">
            {formatProbability(mean)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground uppercase">Range</div>
          <div className="text-lg font-medium text-muted-foreground">
            {formatProbability(min)} \u2013 {formatProbability(max)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground uppercase">
            Sources
          </div>
          <div className="text-xl font-bold text-foreground">
            {estimates.length}
          </div>
        </div>
      </div>

      {/* Individual estimates */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2 text-muted-foreground font-medium">
              Source
            </th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">
              Probability
            </th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">
              80% CI
            </th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">
              As Of
            </th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((estimate, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="py-2 px-2">
                {estimate.url ? (
                  <a
                    href={estimate.url}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {estimate.source}
                  </a>
                ) : (
                  <span>{estimate.source}</span>
                )}
              </td>
              <td className="py-2 px-2 text-right font-mono text-yellow-400">
                {formatProbability(estimate.probability)}
              </td>
              <td className="py-2 px-2 text-right text-muted-foreground font-mono">
                {estimate.confidence
                  ? formatConfidence(estimate.confidence)
                  : "\u2014"}
              </td>
              <td className="py-2 px-2 text-right text-muted-foreground">
                {estimate.asOf || "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2 text-xs text-muted-foreground">
        Note: Estimates reflect different methodologies and timeframes.
        Disagreement is expected.
      </div>
    </div>
  );
}

export function EstimatesCard({ estimates }: { estimates: Estimate[] }) {
  if (!estimates || estimates.length === 0) return null;

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/50">
      <h4 className="text-sm font-semibold text-foreground mb-3">
        Probability Estimates
      </h4>
      <EstimatesPanel estimates={estimates} />
    </div>
  );
}

export default EstimatesPanel;
