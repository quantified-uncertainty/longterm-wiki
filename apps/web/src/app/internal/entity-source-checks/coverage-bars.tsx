"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface CoverageRow {
  recordType: string;
  total: number;
  verified: number;
  percentage: number;
}

/**
 * Visual coverage summary with horizontal progress bars per record type.
 * Fetches data from the /api/source-check-coverage-proxy endpoint.
 */
export function CoverageBars() {
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/source-check-coverage-proxy");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setCoverage(data.coverage ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading coverage data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
        Failed to load coverage: {error}
      </div>
    );
  }

  if (coverage.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        No coverage data available.
      </div>
    );
  }

  // Filter out rows with neither total records nor verdicts (phantom record types)
  const meaningful = coverage.filter((r) => r.total > 0 || r.verified > 0);

  // Sort by percentage descending, then by total descending for ties
  const sorted = [...meaningful].sort((a, b) => {
    if (b.percentage !== a.percentage) return b.percentage - a.percentage;
    return b.total - a.total;
  });

  const totalRecords = sorted.reduce((sum, r) => sum + r.total, 0);
  const totalVerified = sorted.reduce((sum, r) => sum + r.verified, 0);
  const overallPercentage = totalRecords > 0
    ? Math.round((totalVerified / totalRecords) * 100)
    : 0;

  return (
    <div className="not-prose">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-base font-semibold">Record Type Coverage</h3>
        <span className="text-sm text-muted-foreground tabular-nums">
          {totalVerified.toLocaleString()} / {totalRecords.toLocaleString()} records verified ({overallPercentage}%)
        </span>
      </div>

      <div className="space-y-3">
        {sorted.map((row) => (
          <CoverageBar key={row.recordType} row={row} />
        ))}
      </div>
    </div>
  );
}

function CoverageBar({ row }: { row: CoverageRow }) {
  const { recordType, total, verified, percentage } = row;
  const isZero = percentage === 0;
  const isLow = percentage > 0 && percentage < 20;

  return (
    <div className="group">
      <div className="flex items-center justify-between mb-1">
        <span className={cn(
          "text-sm font-medium",
          isZero && "text-amber-600 dark:text-amber-400",
        )}>
          {recordType}
        </span>
        <span className={cn(
          "text-xs tabular-nums",
          isZero
            ? "text-amber-600 dark:text-amber-400 font-semibold"
            : "text-muted-foreground",
        )}>
          {verified.toLocaleString()} / {total.toLocaleString()} ({percentage}%)
        </span>
      </div>
      <div className="h-3 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        {percentage > 0 && (
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              isLow ? "bg-amber-500" : "bg-emerald-500",
            )}
            style={{ width: `${Math.max(percentage, 1)}%` }}
          />
        )}
      </div>
    </div>
  );
}
