/**
 * AnthropicStakeholdersTableClient — interactive client component
 *
 * Programmatic table showing Anthropic stakeholder ownership with computed
 * donation and EA-alignment columns. Dollar values scale with the live
 * valuation passed in as a prop (read server-side by AnthropicStakeholdersTable).
 *
 * Features:
 * - Column visibility toggles (pill buttons)
 * - Canonical fact ID references for auditability (hover to see source)
 * - Pledge shown as a range where uncertain (employee pool: 25–50%)
 * - EA Align % shown as a badge with qualitative label
 * - Derived columns: Exp. Donated = Value × Pledge range; Exp. EA-Effective = Donated × EA Align range
 * - Totals footer across pledged stakeholders
 *
 * Stake fields use null to mean "undisclosed/unknown" (distinct from 0 = "no stake").
 */

"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Column configuration ────────────────────────────────────────────────────

type ColKey =
  | "category"
  | "stake"
  | "value"
  | "pledge"
  | "eaAlign"
  | "donated"
  | "eaEffective";

const COLUMN_CONFIG: Array<{
  key: ColKey;
  shortLabel: string;
  defaultVisible: boolean;
}> = [
  { key: "category", shortLabel: "Category", defaultVisible: true },
  { key: "stake", shortLabel: "Stake", defaultVisible: true },
  { key: "value", shortLabel: "Value", defaultVisible: true },
  { key: "pledge", shortLabel: "Pledge %", defaultVisible: true },
  { key: "eaAlign", shortLabel: "EA Align", defaultVisible: true },
  { key: "donated", shortLabel: "Donated", defaultVisible: true },
  { key: "eaEffective", shortLabel: "EA-Effective", defaultVisible: true },
];

// ─── Stakeholder data ─────────────────────────────────────────────────────────

interface Stakeholder {
  name: string;
  category: string;
  /**
   * Stake as a fraction of total equity (e.g. 0.02 = 2%).
   * null = undisclosed/unknown (distinct from 0 = genuinely no stake).
   */
  stakeMin: number | null;
  stakeMax: number | null;
  /**
   * Fraction pledged to charitable donation.
   * When pledgeMin !== pledgeMax, the table shows a range.
   */
  pledgeMin: number;
  pledgeMax: number;
  /** Estimated probability the pledged donations go to EA-aligned causes. */
  eaAlignMin: number;
  eaAlignMax: number;
  link?: string;
  notes?: string;
  /** Whether this row is included in the totals footer */
  includeInTotal?: boolean;
  /**
   * Canonical fact reference for auditability (format: "entity.factId").
   * Shown as a small hoverable badge next to the value.
   */
  stakeFactRef?: string;
  pledgeFactRef?: string;
}

const STAKEHOLDERS: Stakeholder[] = [
  {
    name: "Dario Amodei",
    category: "Co-founder, CEO",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.8,
    eaAlignMax: 0.9,
    link: "/wiki/E91",
    notes: "GWWC signatory; early GiveWell supporter",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Daniela Amodei",
    category: "Co-founder, President",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.8,
    eaAlignMax: 0.9,
    link: "/wiki/E90",
    notes: "Married to Holden Karnofsky (GiveWell co-founder)",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Chris Olah",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.4,
    eaAlignMax: 0.6,
    link: "/wiki/E59",
    notes: "Interpretability pioneer; safety-focused",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jack Clark",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.3,
    eaAlignMax: 0.5,
    notes: "Former OpenAI Policy Director; responsible AI focus",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Tom Brown",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.1,
    eaAlignMax: 0.2,
    notes: "GPT-3 lead author; no documented EA connections",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jared Kaplan",
    category: "Co-founder, Chief Scientist",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.1,
    eaAlignMax: 0.2,
    notes: "Scaling laws pioneer; no documented EA connections",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Sam McCandlish",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgeMin: 0.8,
    pledgeMax: 0.8,
    eaAlignMin: 0.1,
    eaAlignMax: 0.2,
    notes: "Alignment researcher; no documented EA connections",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jaan Tallinn",
    category: "Early investor",
    stakeMin: 0.006,
    stakeMax: 0.017,
    pledgeMin: 0.9,
    pledgeMax: 0.9,
    eaAlignMin: 0.9,
    eaAlignMax: 0.95,
    link: "/wiki/E577",
    notes: "Led Series A; Skype co-founder; major AI safety funder",
    includeInTotal: true,
    stakeFactRef: "anthropic.d7c6f042",
  },
  {
    name: "Dustin Moskovitz",
    category: "Early investor",
    stakeMin: 0.008,
    stakeMax: 0.025,
    pledgeMin: 0.95,
    pledgeMax: 0.95,
    eaAlignMin: 0.9,
    eaAlignMax: 0.95,
    link: "/wiki/E436",
    notes: "$500M already in Good Ventures nonprofit vehicle",
    includeInTotal: true,
    stakeFactRef: "anthropic.a9e1f835",
  },
  {
    name: "Employee equity pool",
    // ~870–2,847 employees
    category: "Employees",
    // 12–18% of total equity (fact f2a06bd3)
    stakeMin: 0.12,
    stakeMax: 0.18,
    // Blended pledge rate: 25% (post-2024 hires, 1:1 match) to 50% (pre-2025 hires, 3:1 match)
    // Shown as a range to reflect heterogeneity across the employee pool
    pledgeMin: 0.25,
    pledgeMax: 0.5,
    eaAlignMin: 0.4,
    eaAlignMax: 0.7,
    notes:
      "Pledge rates vary: pre-2025 hires up to 50% with 3:1 Anthropic match; post-2024 hires 25% with 1:1 match. EA Forum estimates ~$20\u201340B in employee DAFs already transferred.",
    includeInTotal: true,
    stakeFactRef: "anthropic.f2a06bd3",
    pledgeFactRef: "anthropic.b2c4d87e",
  },
  {
    name: "Google",
    category: "Strategic investor",
    stakeMin: 0.13,
    stakeMax: 0.15,
    pledgeMin: 0,
    pledgeMax: 0,
    eaAlignMin: 0,
    eaAlignMax: 0,
    notes: "$3.3B invested across 3 rounds; no philanthropic pledge",
    stakeFactRef: "anthropic.b3a9f201",
  },
  {
    name: "Amazon",
    category: "Strategic investor",
    // Exact stake is undisclosed — null signals unknown, not zero
    stakeMin: null,
    stakeMax: null,
    pledgeMin: 0,
    pledgeMax: 0,
    eaAlignMin: 0,
    eaAlignMax: 0,
    notes: "$10.75B invested; exact stake undisclosed; primary cloud partner",
    stakeFactRef: "anthropic.9a1f5c63",
  },
  {
    name: "Series G / Other institutional",
    category: "Institutional",
    // Distributed across many institutions; individual stakes undisclosed
    stakeMin: null,
    stakeMax: null,
    pledgeMin: 0,
    pledgeMax: 0,
    eaAlignMin: 0,
    eaAlignMax: 0,
    notes: "GIC, Coatue, D.E. Shaw, Dragoneer, Founders Fund, ICONIQ, MGX",
  },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtB(v: number): string {
  return v < 1e8 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e9).toFixed(1)}B`;
}

function fmtDollarRange(min: number, max: number): string {
  if (Math.abs(min - max) < 0.15e9) return fmtB((min + max) / 2);
  return `${fmtB(min)}\u2013${fmtB(max)}`;
}

/** Format a percentage fraction (0.02 → "2") without unnecessary decimals. */
function fmtPctVal(v: number): string {
  const pct = v * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function fmtStake(min: number | null, max: number | null): string {
  if (min === null || max === null) return "Undisclosed";
  if (Math.abs(min - max) < 0.0001) return `~${fmtPctVal(min)}%`;
  return `${fmtPctVal(min)}\u2013${fmtPctVal(max)}%`;
}

function fmtPledge(min: number, max: number): string {
  if (min === 0 && max === 0) return "\u2014";
  if (Math.abs(min - max) < 0.001) return `${fmtPctVal(min)}%`;
  return `${fmtPctVal(min)}\u2013${fmtPctVal(max)}%`;
}

function fmtEaAlign(min: number, max: number): string {
  if (min === 0 && max === 0) return "\u2014";
  if (Math.abs(min - max) < 0.001) return `${fmtPctVal(min)}%`;
  return `${fmtPctVal(min)}\u2013${fmtPctVal(max)}%`;
}

function eaAlignBadge(
  min: number,
  max: number
): { label: string; cls: string } {
  const mid = (min + max) / 2;
  if (mid >= 0.85)
    return {
      label: "Very high",
      cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800",
    };
  if (mid >= 0.65)
    return {
      label: "High",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    };
  if (mid >= 0.4)
    return {
      label: "Medium",
      cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    };
  if (mid >= 0.08)
    return {
      label: "Low",
      cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800",
    };
  return {
    label: "None",
    cls: "bg-gray-100 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800",
  };
}

// ─── Fact reference badge ─────────────────────────────────────────────────────

/** Small hoverable monospace badge showing the canonical fact ID. */
function FactRef({ factRef }: { factRef: string }) {
  const shortId = factRef.split(".")[1];
  return (
    <span
      className="ml-1 align-middle font-mono text-[9px] text-muted-foreground/40 border border-muted-foreground/20 rounded px-0.5 cursor-help select-none"
      title={`Fact: ${factRef} \u2014 see data/facts/anthropic.yaml`}
    >
      {shortId}
    </span>
  );
}

// ─── Main client component ────────────────────────────────────────────────────

interface Props {
  valuation: number;
  valuationDisplay: string;
  asOf?: string;
}

export function AnthropicStakeholdersTableClient({
  valuation,
  valuationDisplay,
  asOf,
}: Props) {
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(
    new Set(
      COLUMN_CONFIG.filter((c) => c.defaultVisible).map((c) => c.key)
    )
  );

  const toggleCol = (key: ColKey) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const show = (key: ColKey) => visibleCols.has(key);

  // Compute per-row dollar values and derived donation columns
  const rows = STAKEHOLDERS.map((s) => {
    const valueMin = s.stakeMin !== null ? s.stakeMin * valuation : null;
    const valueMax = s.stakeMax !== null ? s.stakeMax * valuation : null;
    // Donated range spans min×min pledge to max×max pledge
    const donatedMin = valueMin !== null ? valueMin * s.pledgeMin : null;
    const donatedMax = valueMax !== null ? valueMax * s.pledgeMax : null;
    const eaMin = donatedMin !== null ? donatedMin * s.eaAlignMin : null;
    const eaMax = donatedMax !== null ? donatedMax * s.eaAlignMax : null;
    return { ...s, valueMin, valueMax, donatedMin, donatedMax, eaMin, eaMax };
  });

  // Totals: only sum rows with known stakes and active pledges
  const totals = rows
    .filter((r) => r.includeInTotal && r.donatedMin !== null)
    .reduce(
      (acc, r) => ({
        donatedMin: acc.donatedMin + (r.donatedMin ?? 0),
        donatedMax: acc.donatedMax + (r.donatedMax ?? 0),
        eaMin: acc.eaMin + (r.eaMin ?? 0),
        eaMax: acc.eaMax + (r.eaMax ?? 0),
      }),
      { donatedMin: 0, donatedMax: 0, eaMin: 0, eaMax: 0 }
    );

  return (
    <div className="my-6 w-full">
      {/* Header + column toggles */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            Anthropic Stakeholder Ownership &amp; Philanthropy
            {asOf && (
              <span className="text-muted-foreground font-normal text-sm ml-2">
                as of {asOf}
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-2xl">
            All dollar values at {valuationDisplay} post-money valuation.{" "}
            <strong>Pledge&nbsp;%</strong> = fraction of equity pledged to charity.{" "}
            <strong>EA&nbsp;Align&nbsp;%</strong> = estimated probability those donations go to EA-aligned causes.
            Ranges reflect uncertainty. Pledges are not legally binding.
            Hover the grey fact IDs to see source references.
          </p>
        </div>

        {/* Column visibility toggles */}
        <div className="flex flex-wrap gap-1.5 items-center shrink-0">
          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
            Columns:
          </span>
          {COLUMN_CONFIG.map((col) => (
            <button
              key={col.key}
              onClick={() => toggleCol(col.key)}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded-full border transition-colors whitespace-nowrap",
                visibleCols.has(col.key)
                  ? "bg-primary/10 text-primary border-primary/30 font-medium"
                  : "bg-muted/50 text-muted-foreground border-border opacity-50"
              )}
            >
              {col.shortLabel}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4 min-w-[180px]">Stakeholder</TableHead>
              {show("category") && (
                <TableHead className="min-w-[140px]">Category</TableHead>
              )}
              {show("stake") && (
                <TableHead className="text-right min-w-[100px]">Est.&nbsp;Stake</TableHead>
              )}
              {show("value") && (
                <TableHead className="text-right min-w-[130px]">
                  Value at {valuationDisplay}
                </TableHead>
              )}
              {show("pledge") && (
                <TableHead className="text-right min-w-[90px]">Pledge&nbsp;%</TableHead>
              )}
              {show("eaAlign") && (
                <TableHead className="text-right min-w-[120px]">EA&nbsp;Align&nbsp;%</TableHead>
              )}
              {show("donated") && (
                <TableHead className="text-right min-w-[130px] bg-blue-500/5">
                  Exp.&nbsp;Donated
                </TableHead>
              )}
              {show("eaEffective") && (
                <TableHead className="text-right min-w-[150px] bg-green-500/5">
                  Exp.&nbsp;EA-Effective
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s, i) => {
              const { label: eaLabel, cls: eaCls } = eaAlignBadge(
                s.eaAlignMin,
                s.eaAlignMax
              );
              const stakeKnown = s.stakeMin !== null && s.stakeMax !== null;
              const hasPledge = s.pledgeMax > 0;

              return (
                <TableRow key={i}>
                  {/* Stakeholder name */}
                  <TableCell className="pl-4 font-medium">
                    {s.link ? (
                      <a href={s.link} className="text-primary hover:underline">
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                    {s.notes && (
                      <span className="block text-[10px] text-muted-foreground/70 font-normal leading-tight mt-0.5">
                        {s.notes}
                      </span>
                    )}
                  </TableCell>

                  {/* Category */}
                  {show("category") && (
                    <TableCell className="text-muted-foreground text-xs">
                      {s.category}
                    </TableCell>
                  )}

                  {/* Est. Stake */}
                  {show("stake") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      {stakeKnown ? (
                        <>
                          {fmtStake(s.stakeMin, s.stakeMax)}
                          {s.stakeFactRef && <FactRef factRef={s.stakeFactRef} />}
                        </>
                      ) : (
                        <span className="text-muted-foreground italic text-xs">
                          Undisclosed
                          {s.stakeFactRef && <FactRef factRef={s.stakeFactRef} />}
                        </span>
                      )}
                    </TableCell>
                  )}

                  {/* Equity Value */}
                  {show("value") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      {stakeKnown && s.valueMin !== null && s.valueMax !== null ? (
                        fmtDollarRange(s.valueMin, s.valueMax)
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {/* Pledge % */}
                  {show("pledge") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      {hasPledge ? (
                        <>
                          {fmtPledge(s.pledgeMin, s.pledgeMax)}
                          {s.pledgeFactRef && <FactRef factRef={s.pledgeFactRef} />}
                        </>
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {/* EA Align % */}
                  {show("eaAlign") && (
                    <TableCell className="text-right">
                      {s.eaAlignMax > 0 ? (
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] whitespace-nowrap", eaCls)}
                        >
                          {fmtEaAlign(s.eaAlignMin, s.eaAlignMax)}&nbsp;&middot;&nbsp;{eaLabel}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {/* Exp. Donated */}
                  {show("donated") && (
                    <TableCell className="text-right text-sm tabular-nums bg-blue-500/5">
                      {hasPledge && stakeKnown && s.donatedMin !== null && s.donatedMax !== null ? (
                        fmtDollarRange(s.donatedMin, s.donatedMax)
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {/* Exp. EA-Effective */}
                  {show("eaEffective") && (
                    <TableCell className="text-right text-sm tabular-nums bg-green-500/5">
                      {s.eaAlignMax > 0 && stakeKnown && s.eaMin !== null && s.eaMax !== null ? (
                        fmtDollarRange(s.eaMin, s.eaMax)
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>

          {/* Totals footer */}
          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell className="pl-4">Totals (pledged stakeholders)</TableCell>
              {show("category") && <TableCell />}
              {show("stake") && <TableCell />}
              {show("value") && <TableCell />}
              {show("pledge") && <TableCell />}
              {show("eaAlign") && <TableCell />}
              {show("donated") && (
                <TableCell className="text-right tabular-nums bg-blue-500/10">
                  {fmtDollarRange(totals.donatedMin, totals.donatedMax)}
                </TableCell>
              )}
              {show("eaEffective") && (
                <TableCell className="text-right tabular-nums bg-green-500/10">
                  {fmtDollarRange(totals.eaMin, totals.eaMax)}
                </TableCell>
              )}
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <p className="text-[10px] text-muted-foreground/60 mt-1.5">
        Grey IDs (e.g.{" "}
        <code className="font-mono text-[9px]">e3b8a291</code>) are canonical
        fact references in{" "}
        <code className="font-mono text-[9px]">data/facts/anthropic.yaml</code>.
        Hover to see the full reference.
      </p>
    </div>
  );
}
