/**
 * AnthropicStakeholdersTable
 *
 * Programmatic table showing Anthropic stakeholder ownership with computed donation
 * and EA-alignment columns. Dollar values scale automatically with the live valuation fact.
 *
 * Columns:
 *   Stakeholder | Category | Est. Stake | Value | Pledge % | EA Align % | Exp. Donated | Exp. EA-Effective
 *
 * Derived columns (computed per row):
 *   Exp. Donated      = Value × Pledge %
 *   Exp. EA-Effective = Exp. Donated × EA Align %
 *
 * Totals footer shows sums across pledged stakeholders only.
 *
 * Stake fields use null to mean "undisclosed/unknown" (distinct from 0 = "no stake").
 */

import { getFact } from "@/data";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Stakeholder {
  name: string;
  category: string;
  /**
   * Stake as a fraction of total equity (e.g. 0.02 = 2%).
   * null = undisclosed/unknown (distinct from 0 = genuinely no stake).
   */
  stakeMin: number | null;
  stakeMax: number | null;
  /** Fraction pledged to charitable donation (e.g. 0.80 = 80%). 0 = no pledge. */
  pledgePct: number;
  /** Estimated probability the pledged donations go to EA-aligned causes. 0 = none. */
  eaAlignPct: number;
  link?: string;
  notes?: string;
  /** Whether this row is included in the totals footer */
  includeInTotal?: boolean;
}

const STAKEHOLDERS: Stakeholder[] = [
  {
    name: "Dario Amodei",
    category: "Co-founder, CEO",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.85,
    link: "/wiki/E91",
    notes: "GWWC signatory; early GiveWell supporter",
    includeInTotal: true,
  },
  {
    name: "Daniela Amodei",
    category: "Co-founder, President",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.85,
    link: "/wiki/E90",
    notes: "Married to Holden Karnofsky (GiveWell co-founder)",
    includeInTotal: true,
  },
  {
    name: "Chris Olah",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.5,
    link: "/wiki/E59",
    notes: "Interpretability pioneer; safety-focused",
    includeInTotal: true,
  },
  {
    name: "Jack Clark",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.4,
    notes: "Former OpenAI Policy Director; responsible AI focus",
    includeInTotal: true,
  },
  {
    name: "Tom Brown",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.15,
    notes: "GPT-3 lead author; no documented EA connections",
    includeInTotal: true,
  },
  {
    name: "Jared Kaplan",
    category: "Co-founder, Chief Scientist",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.15,
    notes: "Scaling laws pioneer; no documented EA connections",
    includeInTotal: true,
  },
  {
    name: "Sam McCandlish",
    category: "Co-founder",
    stakeMin: 0.02,
    stakeMax: 0.03,
    pledgePct: 0.8,
    eaAlignPct: 0.15,
    notes: "Alignment researcher; no documented EA connections",
    includeInTotal: true,
  },
  {
    name: "Jaan Tallinn",
    category: "Early investor",
    stakeMin: 0.006,
    stakeMax: 0.017,
    pledgePct: 0.9,
    eaAlignPct: 0.95,
    link: "/wiki/E577",
    notes: "Led Series A; Skype co-founder; major AI safety funder",
    includeInTotal: true,
  },
  {
    name: "Dustin Moskovitz",
    category: "Early investor",
    stakeMin: 0.008,
    stakeMax: 0.025,
    pledgePct: 0.95,
    eaAlignPct: 0.95,
    link: "/wiki/E436",
    notes: "$500M already in nonprofit vehicle",
    includeInTotal: true,
  },
  {
    name: "Employee equity pool",
    category: "Employees",
    stakeMin: 0.12,
    stakeMax: 0.18,
    pledgePct: 0.5,
    eaAlignPct: 0.6,
    notes: "~870–2,847 employees; 3:1 matching reduced to 1:1 at 25% for post-2024 hires",
    includeInTotal: true,
  },
  {
    name: "Google",
    category: "Strategic investor",
    stakeMin: 0.13,
    stakeMax: 0.15,
    pledgePct: 0,
    eaAlignPct: 0,
    notes: "$3.3B invested across 3 rounds; no philanthropic pledge",
  },
  {
    name: "Amazon",
    category: "Strategic investor",
    // Exact stake is undisclosed — null signals unknown, not zero
    stakeMin: null,
    stakeMax: null,
    pledgePct: 0,
    eaAlignPct: 0,
    notes: "$10.75B invested; exact stake undisclosed; primary cloud partner",
  },
  {
    name: "Series G / Other institutional",
    category: "Institutional",
    // Distributed across many institutions; individual stakes undisclosed
    stakeMin: null,
    stakeMax: null,
    pledgePct: 0,
    eaAlignPct: 0,
    notes: "GIC, Coatue, D.E. Shaw, Dragoneer, Founders Fund, ICONIQ, MGX",
  },
];

function fmtB(v: number): string {
  return v < 1e8 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e9).toFixed(1)}B`;
}

function fmtRange(min: number, max: number): string {
  return Math.abs(min - max) < 0.15e9 ? fmtB(min) : `${fmtB(min)}–${fmtB(max)}`;
}

function fmtStake(min: number | null, max: number | null): string {
  if (min === null || max === null) return "Undisclosed";
  if (Math.abs(min - max) < 0.001) return `~${(min * 100).toFixed(0)}%`;
  return `${(min * 100).toFixed(1)}–${(max * 100).toFixed(1)}%`;
}

function eaAlignBadge(pct: number): { label: string; cls: string } {
  if (pct >= 0.9) return { label: "Very high", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800" };
  if (pct >= 0.7) return { label: "High", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800" };
  if (pct >= 0.45) return { label: "Medium", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800" };
  if (pct >= 0.1) return { label: "Low", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800" };
  return { label: "None", cls: "bg-gray-100 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800" };
}

export function AnthropicStakeholdersTable() {
  const valuationFact = getFact("anthropic", "6796e194");
  const valuation = valuationFact?.numeric ?? 380e9;
  const valuationDisplay = valuationFact?.value ?? "$380B";
  const asOf = valuationFact?.asOf;

  // Compute per-row dollar values and derived donation columns
  const rows = STAKEHOLDERS.map((s) => {
    const valueMin = s.stakeMin !== null ? s.stakeMin * valuation : null;
    const valueMax = s.stakeMax !== null ? s.stakeMax * valuation : null;
    const donatedMin = valueMin !== null ? valueMin * s.pledgePct : null;
    const donatedMax = valueMax !== null ? valueMax * s.pledgePct : null;
    const eaMin = donatedMin !== null ? donatedMin * s.eaAlignPct : null;
    const eaMax = donatedMax !== null ? donatedMax * s.eaAlignPct : null;
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
    <Card className="my-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Anthropic Stakeholder Ownership &amp; Philanthropy
          {asOf && (
            <span className="text-muted-foreground font-normal text-sm ml-2">
              as of {asOf}
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          All dollar values at {valuationDisplay} post-money valuation.{" "}
          <strong>Pledge %</strong> = fraction of equity pledged to charitable giving.{" "}
          <strong>EA Align %</strong> = estimated probability those donations go to
          EA-aligned causes. Derived columns are estimates with significant uncertainty
          — pledges are not legally binding.
        </p>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4 min-w-[140px]">Stakeholder</TableHead>
              <TableHead className="min-w-[120px]">Category</TableHead>
              <TableHead className="text-right">Est. Stake</TableHead>
              <TableHead className="text-right min-w-[120px]">
                Value at {valuationDisplay}
              </TableHead>
              <TableHead className="text-right min-w-[80px]">Pledge %</TableHead>
              <TableHead className="text-right min-w-[90px]">EA Align %</TableHead>
              <TableHead className="text-right min-w-[110px] bg-blue-500/5">
                Exp. Donated
              </TableHead>
              <TableHead className="text-right min-w-[130px] bg-green-500/5">
                Exp. EA-Effective
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s, i) => {
              const { label: eaLabel, cls: eaCls } = eaAlignBadge(s.eaAlignPct);
              const stakeKnown = s.stakeMin !== null && s.stakeMax !== null;
              const hasPledge = s.pledgePct > 0;

              return (
                <TableRow key={i}>
                  <TableCell className="pl-4 font-medium">
                    {s.link ? (
                      <a href={s.link} className="text-primary hover:underline">
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {s.category}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {stakeKnown ? (
                      fmtStake(s.stakeMin, s.stakeMax)
                    ) : (
                      <span className="text-muted-foreground italic text-xs">Undisclosed</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {stakeKnown && s.valueMin !== null && s.valueMax !== null ? (
                      fmtRange(s.valueMin, s.valueMax)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {hasPledge ? (
                      `${Math.round(s.pledgePct * 100)}%`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.eaAlignPct > 0 ? (
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] whitespace-nowrap", eaCls)}
                      >
                        {Math.round(s.eaAlignPct * 100)}% · {eaLabel}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums bg-blue-500/5">
                    {hasPledge && stakeKnown && s.donatedMin !== null && s.donatedMax !== null ? (
                      fmtRange(s.donatedMin, s.donatedMax)
                    ) : (
                      <span className="text-muted-foreground">$0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums bg-green-500/5">
                    {s.eaAlignPct > 0 && stakeKnown && s.eaMin !== null && s.eaMax !== null ? (
                      fmtRange(s.eaMin, s.eaMax)
                    ) : (
                      <span className="text-muted-foreground">$0</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell className="pl-4" colSpan={6}>
                Totals (pledged stakeholders only)
              </TableCell>
              <TableCell className="text-right tabular-nums bg-blue-500/10">
                {fmtRange(totals.donatedMin, totals.donatedMax)}
              </TableCell>
              <TableCell className="text-right tabular-nums bg-green-500/10">
                {fmtRange(totals.eaMin, totals.eaMax)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

export default AnthropicStakeholdersTable;
