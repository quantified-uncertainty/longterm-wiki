/**
 * Equity Positions section for organization profile pages.
 * Shows holder, category, stake %, estimated value, pledge %, and notes.
 * Value is computed from stake × latest valuation when available.
 * Pledge % is joined from charitable-pledges KB records by holder ID.
 */
import Link from "next/link";
import { getRecordVerdict } from "@data/tablebase";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import { CoverageDots } from "@/components/coverage/CoverageDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedEquityPositionRecord, ParsedInvestmentRecord, ParsedCharitablePledgeRecord, NumericOrRange } from "./org-data";
import { formatStake, deriveEquityCategory, computeStakeValue, numericValue } from "./org-data";

// ── Category badge colors ────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  "Co-founder": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "Early investor": "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "Strategic investor": "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  Employees: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Institutional: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  Investor: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS["Investor"];
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${color}`}>
      {category}
    </span>
  );
}

// ── Value formatting ─────────────────────────────────────────────────

function formatValueRange(value: NumericOrRange | null): string {
  if (value == null) return "\u2014";
  if (Array.isArray(value)) {
    return `${formatCompactCurrency(value[0])}\u2013${formatCompactCurrency(value[1])}`;
  }
  return formatCompactCurrency(value);
}

/** Format a pledge fraction as percentage, supporting single values and ranges. */
function formatPledge(pledge: NumericOrRange | null): string {
  if (pledge == null) return "\u2014";
  if (Array.isArray(pledge)) {
    const low = (pledge[0] * 100).toFixed(0);
    const high = (pledge[1] * 100).toFixed(0);
    return `${low}%\u2013${high}%`;
  }
  return `${(pledge * 100).toFixed(0)}%`;
}

// ── Component ────────────────────────────────────────────────────────

export function EquityPositionsSection({
  positions,
  investments,
  latestValuation,
  valuationLabel,
  charitablePledges,
}: {
  positions: ParsedEquityPositionRecord[];
  investments?: ParsedInvestmentRecord[];
  latestValuation?: number | null;
  valuationLabel?: string;
  charitablePledges?: ParsedCharitablePledgeRecord[];
}) {
  if (positions.length === 0) return null;

  const hasValuation = latestValuation != null && latestValuation > 0;

  // Build investment index: holderId → investment records for category derivation
  const investmentsByHolder = new Map<string, ParsedInvestmentRecord[]>();
  if (investments) {
    for (const inv of investments) {
      const key = inv.investorId;
      if (!key) continue;
      const list = investmentsByHolder.get(key) ?? [];
      list.push(inv);
      investmentsByHolder.set(key, list);
    }
  }

  // Build pledge index: pledgerId → pledge record
  const pledgeByHolder = new Map<string, ParsedCharitablePledgeRecord>();
  if (charitablePledges) {
    for (const p of charitablePledges) {
      if (p.pledgerId) pledgeByHolder.set(p.pledgerId, p);
    }
  }

  // Enrich positions with category, value, and pledge
  const enriched = positions.map((pos) => {
    const holderInvestments = pos.holderId
      ? (investmentsByHolder.get(pos.holderId) ?? [])
      : [];
    const category = investments
      ? deriveEquityCategory(pos.holderName, holderInvestments)
      : null;
    const value = hasValuation
      ? computeStakeValue(pos.stake, latestValuation)
      : null;
    const pledge = pos.holderId ? (pledgeByHolder.get(pos.holderId)?.pledge ?? null) : null;
    return { ...pos, category, value, pledge };
  });

  // Compute totals
  const totalStakeMid = enriched.reduce((sum, p) => sum + numericValue(p.stake), 0);
  const totalValueMid = hasValuation ? totalStakeMid * latestValuation : null;

  const hasCategories = enriched.some((p) => p.category != null);
  const hasPledges = enriched.some((p) => p.pledge != null);

  const valLabel = valuationLabel ?? (hasValuation ? formatCompactCurrency(latestValuation) : null);

  return (
    <section>
      <SectionHeader title="Equity Positions" count={positions.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Holder</th>
              {hasCategories && (
                <th scope="col" className="text-left py-2 px-3 font-medium">Category</th>
              )}
              <th scope="col" className="text-right py-2 px-3 font-medium">Stake</th>
              {hasValuation && (
                <th scope="col" className="text-right py-2 px-3 font-medium whitespace-nowrap">
                  Value at {valLabel}
                </th>
              )}
              {hasPledges && (
                <th scope="col" className="text-right py-2 px-3 font-medium">Pledge %</th>
              )}
              <th scope="col" className="py-2 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {enriched.map((pos) => {
              const verdict = getRecordVerdict("equity-position", String(pos.key));
              return (
                <tr key={pos.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <div>
                      <span className="font-medium text-foreground text-xs">
                        {pos.holderHref ? (
                          <Link href={pos.holderHref} className="text-primary hover:underline">
                            {pos.holderName}
                          </Link>
                        ) : (
                          pos.holderName
                        )}
                      </span>
                      {pos.source && (
                        <a
                          href={safeHref(pos.source)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                        >
                          source
                        </a>
                      )}
                    </div>
                    {pos.notes && (
                      <div className="text-[11px] text-muted-foreground/70 leading-tight mt-0.5">
                        {pos.notes}
                      </div>
                    )}
                  </td>
                  {hasCategories && (
                    <td className="py-2 px-3">
                      {pos.category && <CategoryBadge category={pos.category} />}
                    </td>
                  )}
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {pos.stake != null && (
                      <span className="font-semibold">{formatStake(pos.stake)}</span>
                    )}
                  </td>
                  {hasValuation && (
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      <span className="font-semibold">{formatValueRange(pos.value)}</span>
                    </td>
                  )}
                  {hasPledges && (
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {pos.pledge != null ? (
                        <span className="font-semibold">{formatPledge(pos.pledge)}</span>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>
                  )}
                  <td className="py-2 px-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <CoverageDots score={computeGenericCoverage({
                        filledFieldCount: (pos.stake != null ? 1 : 0) + (pos.source ? 1 : 0) + (pos.notes ? 1 : 0),
                      })} />
                      <SourceCheckDot
                        status={recordVerdictToStatus(verdict?.verdict)}
                        originalVerdict={verdict?.verdict}
                        size="md"
                        href={verdict?.verdict ? getSourceCheckHref("equity-position", String(pos.key)) : undefined}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/* Totals row */}
          {(totalStakeMid > 0) && (
            <tfoot>
              <tr className="border-t border-border bg-muted/20 text-xs font-semibold">
                <td className="py-2 px-3">
                  Total
                </td>
                {hasCategories && <td />}
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                  {formatStake(totalStakeMid)}
                </td>
                {hasValuation && (
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                    {totalValueMid != null ? formatCompactCurrency(totalValueMid) : "\u2014"}
                  </td>
                )}
                {hasPledges && <td />}
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
