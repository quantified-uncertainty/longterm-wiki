/**
 * CampaignFinance — displays campaign finance data for a politician.
 *
 * Server component that fetches finance data and renders:
 * - Latest cycle with a stacked horizontal bar chart (funding breakdown)
 * - Previous cycles in a compact summary table
 *
 * Color scheme:
 *   Individual = blue, PAC = orange, Small donor = green, Self-funding = gray
 *
 * Usage:
 *   import { CampaignFinance, fetchCampaignFinance } from "@/components/political";
 *   const finance = await fetchCampaignFinance(entityId);
 *   <CampaignFinance records={finance} />
 */

import { cn } from "@/lib/utils";
import { safeHref, formatCompactCurrency } from "@/lib/format-compact";
import type { CampaignFinanceRecord } from "./types";

// ── Numeric parsing ─────────────────────────────────────────────────

/** Parse a PG numeric string to number, returning 0 for null/invalid. */
function toNum(value: string | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

// ── Funding breakdown ───────────────────────────────────────────────

interface FundingSegment {
  label: string;
  value: number;
  colorClass: string;
  bgClass: string;
}

function getFundingBreakdown(record: CampaignFinanceRecord): FundingSegment[] {
  const segments: FundingSegment[] = [
    {
      label: "Individual",
      value: toNum(record.individualContributions),
      colorClass: "bg-blue-500",
      bgClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    },
    {
      label: "PAC",
      value: toNum(record.pacContributions),
      colorClass: "bg-orange-500",
      bgClass: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    },
    {
      label: "Small Donor",
      value: toNum(record.smallDonorContributions),
      colorClass: "bg-emerald-500",
      bgClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    },
    {
      label: "Self-Funding",
      value: toNum(record.selfFunding),
      colorClass: "bg-gray-400",
      bgClass: "bg-gray-100 text-gray-700 dark:bg-gray-800/40 dark:text-gray-300",
    },
  ];

  return segments.filter((s) => s.value > 0);
}

// ── Party badge ─────────────────────────────────────────────────────

const PARTY_BADGE: Record<string, string> = {
  democratic: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  republican: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  independent: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

function partyBadgeClass(party: string | null): string | null {
  if (!party) return null;
  return (
    PARTY_BADGE[party.toLowerCase()] ??
    "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400"
  );
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Component ───────────────────────────────────────────────────────

export interface CampaignFinanceProps {
  records: CampaignFinanceRecord[];
}

export function CampaignFinance({ records }: CampaignFinanceProps) {
  if (records.length === 0) return null;

  // Sort by cycle descending (most recent first)
  const sorted = [...records].sort((a, b) => b.cycle - a.cycle);
  const latest = sorted[0];
  const previous = sorted.slice(1);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Campaign Finance
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {sorted.length} {sorted.length === 1 ? "cycle" : "cycles"}
        </span>
      </h2>

      {/* Latest cycle — prominent display */}
      <LatestCycleCard record={latest} />

      {/* Previous cycles — compact table */}
      {previous.length > 0 && (
        <div className="mt-3">
          <PreviousCyclesTable records={previous} />
        </div>
      )}
    </section>
  );
}

// ── Latest cycle card ───────────────────────────────────────────────

function LatestCycleCard({ record }: { record: CampaignFinanceRecord }) {
  const totalRaised = toNum(record.totalRaised);
  const totalSpent = toNum(record.totalSpent);
  const cashOnHand = toNum(record.cashOnHand);
  const segments = getFundingBreakdown(record);
  const segmentTotal = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 bg-muted/30 border-b border-border/60 flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold tabular-nums">
          {record.cycle} Cycle
        </h3>
        {record.party && (
          <span
            className={cn(
              "inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold",
              partyBadgeClass(record.party)
            )}
          >
            {titleCase(record.party)}
          </span>
        )}
        {record.officeType && (
          <span className="text-xs text-muted-foreground">
            {titleCase(record.officeType)}
            {record.state ? ` \u2014 ${record.state}${record.district ? `-${record.district}` : ""}` : ""}
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Key figures */}
        <div className="grid grid-cols-3 gap-4">
          <FinanceFigure label="Total Raised" value={totalRaised} />
          <FinanceFigure label="Total Spent" value={totalSpent} />
          <FinanceFigure label="Cash on Hand" value={cashOnHand} />
        </div>

        {/* Stacked bar chart */}
        {segmentTotal > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Funding Breakdown
            </p>

            {/* Bar */}
            <div
              className="flex h-5 rounded-full overflow-hidden bg-muted/30"
              role="img"
              aria-label={`Funding breakdown: ${segments.map((s) => `${s.label}: ${formatCompactCurrency(s.value)}`).join(", ")}`}
            >
              {segments.map((seg) => {
                const pct = (seg.value / segmentTotal) * 100;
                if (pct < 0.5) return null; // skip negligible slices
                return (
                  <div
                    key={seg.label}
                    className={cn("h-full transition-all", seg.colorClass)}
                    style={{ width: `${pct}%` }}
                    title={`${seg.label}: ${formatCompactCurrency(seg.value)} (${pct.toFixed(1)}%)`}
                  />
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {segments.map((seg) => (
                <div key={seg.label} className="flex items-center gap-1.5 text-xs">
                  <div className={cn("w-2.5 h-2.5 rounded-sm shrink-0", seg.colorClass)} />
                  <span className="text-muted-foreground">{seg.label}</span>
                  <span className="font-medium tabular-nums">
                    {formatCompactCurrency(seg.value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data attribution */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {record.dataAsOf && (
            <span>Data as of {record.dataAsOf}</span>
          )}
          {record.sourceUrl && (
            <a
              href={safeHref(record.sourceUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Source
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Finance figure (key metric) ─────────────────────────────────────

function FinanceFigure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p className="text-base font-bold tabular-nums mt-0.5">
        {value > 0 ? formatCompactCurrency(value) : "\u2014"}
      </p>
    </div>
  );
}

// ── Previous cycles table ───────────────────────────────────────────

function PreviousCyclesTable({
  records,
}: {
  records: CampaignFinanceRecord[];
}) {
  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2 bg-muted/30 border-b border-border/60">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Previous Cycles
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/10">
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Cycle
              </th>
              <th className="text-right px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Raised
              </th>
              <th className="text-right px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Spent
              </th>
              <th className="text-right px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Individual
              </th>
              <th className="text-right px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                PAC
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr
                key={record.id}
                className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
              >
                <td className="px-4 py-2 font-medium tabular-nums">
                  {record.cycle}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {toNum(record.totalRaised) > 0 ? formatCompactCurrency(toNum(record.totalRaised)) : "\u2014"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {toNum(record.totalSpent) > 0 ? formatCompactCurrency(toNum(record.totalSpent)) : "\u2014"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {toNum(record.individualContributions) > 0 ? formatCompactCurrency(toNum(record.individualContributions)) : "\u2014"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {toNum(record.pacContributions) > 0 ? formatCompactCurrency(toNum(record.pacContributions)) : "\u2014"}
                </td>
                <td className="px-4 py-2 text-xs">
                  {record.sourceUrl ? (
                    <a
                      href={safeHref(record.sourceUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Source
                    </a>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
