"use client";

/**
 * CampaignFinanceCell — compact campaign finance summary for directory tables.
 *
 * Shows "$X.XM raised" inline with a hover tooltip showing funding breakdown
 * for the most recent cycle. This is a client component for tooltip hover state.
 *
 * Usage in a directory table:
 *   import { CampaignFinanceCell } from "@/components/political";
 *   <CampaignFinanceCell records={financeRecords} />
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { formatCompactCurrency } from "@/lib/format-compact";
import type { CampaignFinanceRecord } from "./types";
import { toNum } from "./utils";

// ── Funding segment colors ──────────────────────────────────────────

interface FundingLine {
  label: string;
  value: number;
  dotColor: string;
}

function getBreakdownLines(record: CampaignFinanceRecord): FundingLine[] {
  const lines: FundingLine[] = [
    { label: "Individual", value: toNum(record.individualContributions), dotColor: "bg-blue-500" },
    { label: "PAC", value: toNum(record.pacContributions), dotColor: "bg-orange-500" },
    { label: "Small Donor", value: toNum(record.smallDonorContributions), dotColor: "bg-emerald-500" },
    { label: "Self-Funding", value: toNum(record.selfFunding), dotColor: "bg-gray-400" },
  ];
  return lines.filter((l) => l.value > 0);
}

// ── Component ───────────────────────────────────────────────────────

export interface CampaignFinanceCellProps {
  records: CampaignFinanceRecord[];
}

export function CampaignFinanceCell({ records }: CampaignFinanceCellProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowTooltip(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setShowTooltip(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (records.length === 0) {
    return <span className="text-muted-foreground/40">&ndash;</span>;
  }

  // Pick the most recent cycle
  const latest = [...records].sort((a, b) => b.cycle - a.cycle)[0];
  const totalRaised = toNum(latest.totalRaised);
  const breakdownLines = getBreakdownLines(latest);

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Inline display */}
      <span className="text-xs font-medium tabular-nums">
        {totalRaised > 0 ? (
          <>
            <span className="text-foreground">
              {formatCompactCurrency(totalRaised)}
            </span>
            <span className="text-muted-foreground ml-1">raised</span>
          </>
        ) : (
          <span className="text-muted-foreground/40">&ndash;</span>
        )}
      </span>

      {/* Tooltip with breakdown */}
      {showTooltip && totalRaised > 0 && (
        <div
          className={cn(
            "absolute z-50 bottom-full left-0 mb-2",
            "bg-popover text-popover-foreground border border-border rounded-lg shadow-lg",
            "p-3 min-w-[200px] max-w-[280px]"
          )}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
            {latest.cycle} Cycle
          </p>

          {/* Summary figures */}
          <div className="space-y-1 mb-2">
            <TooltipLine
              label="Raised"
              value={formatCompactCurrency(totalRaised)}
            />
            {toNum(latest.totalSpent) > 0 && (
              <TooltipLine
                label="Spent"
                value={formatCompactCurrency(toNum(latest.totalSpent))}
              />
            )}
            {toNum(latest.cashOnHand) > 0 && (
              <TooltipLine
                label="Cash on Hand"
                value={formatCompactCurrency(toNum(latest.cashOnHand))}
              />
            )}
          </div>

          {/* Breakdown */}
          {breakdownLines.length > 0 && (
            <>
              <div className="border-t border-border/40 pt-1.5 mt-1.5">
                <div className="space-y-1">
                  {breakdownLines.map((line) => (
                    <div
                      key={line.label}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "w-2 h-2 rounded-sm shrink-0",
                            line.dotColor
                          )}
                        />
                        <span className="text-muted-foreground">
                          {line.label}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatCompactCurrency(line.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Tooltip arrow */}
          <div className="absolute top-full left-4 w-2 h-2 -mt-1 rotate-45 bg-popover border-r border-b border-border" />
        </div>
      )}
    </div>
  );
}

// ── Tooltip line ────────────────────────────────────────────────────

function TooltipLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
