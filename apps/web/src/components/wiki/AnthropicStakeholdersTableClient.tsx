/**
 * AnthropicStakeholdersTableClient — interactive client component
 *
 * Features:
 * - Column visibility toggles
 * - User-adjustable parameters (valuation, pledge multiplier)
 * - Radix HoverCards on fact values (interactive, stays open on cursor move)
 * - Entity preview HoverCards on stakeholder name links
 * - Pledge shown as a range where uncertain (employee pool: 25–50%)
 * - Derived columns: Exp. Donated, Exp. EA-Effective
 * - Totals footer across pledged stakeholders
 */

"use client";

import { useState } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Exported types (used by server wrapper) ─────────────────────────────────

export interface FactData {
  label?: string;
  value?: string;
  asOf?: string;
  note?: string;
  sourceTitle?: string;
  sourcePublication?: string;
  sourceCredibility?: number;
}

export interface EntityPreview {
  title: string;
  type?: string;
  description?: string;
  href: string;
}

// ─── Column configuration ─────────────────────────────────────────────────────

type ColKey = "category" | "stake" | "value" | "pledge" | "eaAlign" | "donated" | "eaEffective";

const COLUMN_CONFIG: Array<{ key: ColKey; shortLabel: string; defaultVisible: boolean }> = [
  { key: "category",    shortLabel: "Category",     defaultVisible: true },
  { key: "stake",       shortLabel: "Stake",         defaultVisible: true },
  { key: "value",       shortLabel: "Value",         defaultVisible: true },
  { key: "pledge",      shortLabel: "Pledge %",      defaultVisible: true },
  { key: "eaAlign",     shortLabel: "EA Align",      defaultVisible: true },
  { key: "donated",     shortLabel: "Donated",       defaultVisible: true },
  { key: "eaEffective", shortLabel: "EA-Effective",  defaultVisible: true },
];

// ─── Stakeholder data ─────────────────────────────────────────────────────────

interface Stakeholder {
  name: string;
  category: string;
  stakeMin: number | null;
  stakeMax: number | null;
  pledgeMin: number;
  pledgeMax: number;
  eaAlignMin: number;
  eaAlignMax: number;
  link?: string;
  notes?: string;
  includeInTotal?: boolean;
  stakeFactRef?: string;
  pledgeFactRef?: string;
}

const STAKEHOLDERS: Stakeholder[] = [
  {
    name: "Dario Amodei",
    category: "Co-founder, CEO",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.8, eaAlignMax: 0.9,
    link: "/wiki/E91",
    notes: "GWWC signatory; early GiveWell supporter",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Daniela Amodei",
    category: "Co-founder, President",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.8, eaAlignMax: 0.9,
    link: "/wiki/E90",
    notes: "Married to Holden Karnofsky (GiveWell co-founder)",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Chris Olah",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.4, eaAlignMax: 0.6,
    link: "/wiki/E59",
    notes: "Interpretability pioneer; participated in EA events; safety-focused",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jack Clark",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.3, eaAlignMax: 0.5,
    notes: "Former OpenAI Policy Director; responsible AI advocate; EA-adjacent framing",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Tom Brown",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "GPT-3 lead author; chose Anthropic's safety mission over other options",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jared Kaplan",
    category: "Co-founder, Chief Scientist",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "Scaling laws pioneer; safety-motivated co-founder; no documented EA pledge",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Sam McCandlish",
    category: "Co-founder",
    stakeMin: 0.02, stakeMax: 0.03,
    pledgeMin: 0.8, pledgeMax: 0.8,
    eaAlignMin: 0.15, eaAlignMax: 0.3,
    notes: "Alignment researcher; no publicly documented EA connections",
    includeInTotal: true,
    stakeFactRef: "anthropic.e3b8a291",
  },
  {
    name: "Jaan Tallinn",
    category: "Early investor",
    stakeMin: 0.006, stakeMax: 0.017,
    pledgeMin: 0.9, pledgeMax: 0.9,
    eaAlignMin: 0.9, eaAlignMax: 0.95,
    link: "/wiki/E577",
    notes: "Led Series A; Skype co-founder; major AI safety funder",
    includeInTotal: true,
    stakeFactRef: "anthropic.d7c6f042",
  },
  {
    name: "Dustin Moskovitz",
    category: "Early investor",
    stakeMin: 0.008, stakeMax: 0.025,
    pledgeMin: 0.95, pledgeMax: 0.95,
    eaAlignMin: 0.9, eaAlignMax: 0.95,
    link: "/wiki/E436",
    notes: "$500M already in Good Ventures nonprofit vehicle",
    includeInTotal: true,
    stakeFactRef: "anthropic.a9e1f835",
  },
  {
    name: "Employee equity pool",
    category: "Employees",
    stakeMin: 0.12, stakeMax: 0.18,
    pledgeMin: 0.25, pledgeMax: 0.5,
    eaAlignMin: 0.4, eaAlignMax: 0.7,
    notes: "Pledge rates vary: pre-2025 hires up to 50% with 3:1 match; post-2024 hires 25% with 1:1 match. EA Forum estimates ~$20\u201340B in employee DAFs already transferred.",
    includeInTotal: true,
    stakeFactRef: "anthropic.f2a06bd3",
    pledgeFactRef: "anthropic.b2c4d87e",
  },
  {
    name: "Google",
    category: "Strategic investor",
    stakeMin: 0.13, stakeMax: 0.15,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
    notes: "$3.3B invested across 3 rounds; no philanthropic pledge",
    stakeFactRef: "anthropic.b3a9f201",
  },
  {
    name: "Amazon",
    category: "Strategic investor",
    stakeMin: null, stakeMax: null,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
    notes: "$10.75B invested; exact stake undisclosed; primary cloud partner",
    stakeFactRef: "anthropic.9a1f5c63",
  },
  {
    name: "Series G / Other institutional",
    category: "Institutional",
    stakeMin: null, stakeMax: null,
    pledgeMin: 0, pledgeMax: 0,
    eaAlignMin: 0, eaAlignMax: 0,
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

function eaAlignBadge(min: number, max: number): { label: string; cls: string } {
  const mid = (min + max) / 2;
  if (mid >= 0.85) return { label: "Very high", cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800" };
  if (mid >= 0.65) return { label: "High",      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800" };
  if (mid >= 0.4)  return { label: "Medium",    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800" };
  if (mid >= 0.08) return { label: "Low",       cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800" };
  return { label: "None", cls: "bg-gray-100 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800" };
}

// ─── Fact hover card ──────────────────────────────────────────────────────────

function FactHoverCard({ factData, children }: { factData?: FactData; children: React.ReactNode }) {
  if (!factData) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={200} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <span className="border-b border-dotted border-muted-foreground/50 cursor-help decoration-muted-foreground/40">
          {children}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="w-[260px] p-3 bg-popover text-popover-foreground border rounded-md shadow-lg z-50 text-xs"
          sideOffset={4}
          align="start"
        >
          <HoverCard.Arrow className="fill-border" />
          {factData.label && (
            <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1">
              {factData.label}
            </span>
          )}
          {factData.value && (
            <span className="block font-semibold text-foreground mb-1">{factData.value}</span>
          )}
          {factData.asOf && (
            <span className="block text-muted-foreground">As of: {factData.asOf}</span>
          )}
          {factData.note && (
            <span className="block text-muted-foreground mt-1 leading-snug">{factData.note}</span>
          )}
          {factData.sourceTitle && (
            <span className="block text-muted-foreground mt-1.5">
              <span className="block truncate">Source: {factData.sourceTitle}</span>
              {factData.sourcePublication && (
                <span className="flex items-center gap-1 mt-0.5">
                  <span className="text-muted-foreground/80">{factData.sourcePublication}</span>
                  {factData.sourceCredibility != null && (
                    <span className={cn(
                      "inline-block px-1 py-px rounded text-[9px] font-medium",
                      factData.sourceCredibility >= 4 ? "bg-green-500/15 text-green-600 dark:text-green-400" :
                      factData.sourceCredibility >= 3 ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400" :
                      "bg-red-500/15 text-red-600 dark:text-red-400"
                    )}>
                      {factData.sourceCredibility}/5
                    </span>
                  )}
                </span>
              )}
            </span>
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

// ─── Entity preview hover card ────────────────────────────────────────────────

function formatEntityType(type: string): string {
  return type.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function EntityPreviewLink({
  name,
  link,
  preview,
}: {
  name: string;
  link: string;
  preview?: EntityPreview;
}) {
  if (!preview) {
    return (
      <a href={link} className="text-primary hover:underline font-medium">
        {name}
      </a>
    );
  }
  return (
    <HoverCard.Root openDelay={200} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <a
          href={preview.href}
          className="text-primary hover:underline font-medium"
        >
          {name}
        </a>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="w-[280px] p-3 bg-popover text-popover-foreground border rounded-md shadow-lg z-50 text-xs"
          sideOffset={4}
          align="start"
        >
          <HoverCard.Arrow className="fill-border" />
          {preview.type && (
            <span className="block text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1">
              {formatEntityType(preview.type)}
            </span>
          )}
          <span className="block font-semibold text-foreground text-sm mb-1">{preview.title}</span>
          {preview.description && (
            <span className="block text-muted-foreground leading-snug">
              {preview.description.length > 200
                ? preview.description.slice(0, 200) + "..."
                : preview.description}
            </span>
          )}
          <span className="block text-primary/60 mt-1.5 text-[10px]">Click to open page →</span>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  valuation: number;
  valuationDisplay: string;
  asOf?: string;
  facts: Record<string, FactData>;
  entityPreviews: Record<string, EntityPreview>;
}

export function AnthropicStakeholdersTableClient({
  valuation,
  valuationDisplay,
  asOf,
  facts,
  entityPreviews,
}: Props) {
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(
    new Set(COLUMN_CONFIG.filter((c) => c.defaultVisible).map((c) => c.key))
  );
  // User-adjustable valuation override (in billions)
  const [customValBn, setCustomValBn] = useState<string>("");
  const effectiveValuation = customValBn !== "" ? parseFloat(customValBn) * 1e9 : valuation;
  const effectiveDisplay = customValBn !== "" ? `$${customValBn}B` : valuationDisplay;

  const toggleCol = (key: ColKey) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const show = (key: ColKey) => visibleCols.has(key);

  const rows = STAKEHOLDERS.map((s) => {
    const valueMin = s.stakeMin !== null ? s.stakeMin * effectiveValuation : null;
    const valueMax = s.stakeMax !== null ? s.stakeMax * effectiveValuation : null;
    const donatedMin = valueMin !== null ? valueMin * s.pledgeMin : null;
    const donatedMax = valueMax !== null ? valueMax * s.pledgeMax : null;
    const eaMin = donatedMin !== null ? donatedMin * s.eaAlignMin : null;
    const eaMax = donatedMax !== null ? donatedMax * s.eaAlignMax : null;
    return { ...s, valueMin, valueMax, donatedMin, donatedMax, eaMin, eaMax };
  });

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
      {/* Header row */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            Anthropic Stakeholder Ownership &amp; Philanthropy
            {asOf && (
              <span className="text-muted-foreground font-normal text-sm ml-2">
                as of {asOf}
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-2xl">
            Dollar values at{" "}
            <FactHoverCard factData={facts["anthropic.6796e194"]}>
              {effectiveDisplay} valuation
            </FactHoverCard>
            . <strong>Pledge&nbsp;%</strong> = fraction of equity pledged to charity.{" "}
            <strong>EA&nbsp;Align&nbsp;%</strong> = estimated probability donations go to EA-aligned causes.
            Hover underlined values for sources.
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

      {/* Parameter input */}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Adjust valuation:</span>
        <label className="flex items-center gap-1.5">
          <span className="text-foreground">$</span>
          <input
            type="number"
            min={1}
            max={10000}
            step={10}
            value={customValBn}
            onChange={(e) => setCustomValBn(e.target.value)}
            placeholder={String(Math.round(valuation / 1e9))}
            className="w-24 px-2 py-0.5 border rounded text-xs text-foreground bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <span>B</span>
        </label>
        {customValBn !== "" && (
          <button
            onClick={() => setCustomValBn("")}
            className="text-muted-foreground hover:text-foreground underline text-[11px]"
          >
            Reset to {valuationDisplay}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4 min-w-[180px]">Stakeholder</TableHead>
              {show("category")    && <TableHead className="min-w-[140px]">Category</TableHead>}
              {show("stake")       && <TableHead className="text-right min-w-[110px]">Est.&nbsp;Stake</TableHead>}
              {show("value")       && <TableHead className="text-right min-w-[140px]">Value at {effectiveDisplay}</TableHead>}
              {show("pledge")      && <TableHead className="text-right min-w-[90px]">Pledge&nbsp;%</TableHead>}
              {show("eaAlign")     && <TableHead className="text-right min-w-[130px]">EA&nbsp;Align&nbsp;%</TableHead>}
              {show("donated")     && <TableHead className="text-right min-w-[130px] bg-blue-500/5">Exp.&nbsp;Donated</TableHead>}
              {show("eaEffective") && <TableHead className="text-right min-w-[150px] bg-green-500/5">Exp.&nbsp;EA-Effective</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s, i) => {
              const { label: eaLabel, cls: eaCls } = eaAlignBadge(s.eaAlignMin, s.eaAlignMax);
              const stakeKnown = s.stakeMin !== null && s.stakeMax !== null;
              const hasPledge = s.pledgeMax > 0;
              const stakeFactData = s.stakeFactRef ? facts[s.stakeFactRef] : undefined;
              const pledgeFactData = s.pledgeFactRef ? facts[s.pledgeFactRef] : undefined;

              return (
                <TableRow key={i}>
                  {/* Stakeholder name */}
                  <TableCell className="pl-4 font-medium">
                    {s.link ? (
                      <EntityPreviewLink
                        name={s.name}
                        link={s.link}
                        preview={entityPreviews[s.link]}
                      />
                    ) : (
                      <span className="font-medium">{s.name}</span>
                    )}
                    {s.notes && (
                      <span className="block text-[10px] text-muted-foreground/70 font-normal leading-tight mt-0.5">
                        {s.notes}
                      </span>
                    )}
                  </TableCell>

                  {show("category") && (
                    <TableCell className="text-muted-foreground text-xs">{s.category}</TableCell>
                  )}

                  {show("stake") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      <FactHoverCard factData={stakeFactData}>
                        {stakeKnown ? (
                          fmtStake(s.stakeMin, s.stakeMax)
                        ) : (
                          <span className="text-muted-foreground italic text-xs">Undisclosed</span>
                        )}
                      </FactHoverCard>
                    </TableCell>
                  )}

                  {show("value") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      {stakeKnown && s.valueMin !== null && s.valueMax !== null ? (
                        <FactHoverCard factData={stakeFactData}>
                          {fmtDollarRange(s.valueMin, s.valueMax)}
                        </FactHoverCard>
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {show("pledge") && (
                    <TableCell className="text-right text-sm tabular-nums">
                      {hasPledge ? (
                        <FactHoverCard factData={pledgeFactData ?? stakeFactData}>
                          {fmtPledge(s.pledgeMin, s.pledgeMax)}
                        </FactHoverCard>
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {show("eaAlign") && (
                    <TableCell className="text-right">
                      {s.eaAlignMax > 0 ? (
                        <Badge variant="outline" className={cn("text-[10px] whitespace-nowrap", eaCls)}>
                          {fmtEaAlign(s.eaAlignMin, s.eaAlignMax)}&nbsp;&middot;&nbsp;{eaLabel}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">&mdash;</span>
                      )}
                    </TableCell>
                  )}

                  {show("donated") && (
                    <TableCell className="text-right text-sm tabular-nums bg-blue-500/5">
                      {hasPledge && stakeKnown && s.donatedMin !== null && s.donatedMax !== null ? (
                        fmtDollarRange(s.donatedMin, s.donatedMax)
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </TableCell>
                  )}

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

          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell className="pl-4">Totals (pledged stakeholders)</TableCell>
              {show("category")    && <TableCell />}
              {show("stake")       && <TableCell />}
              {show("value")       && <TableCell />}
              {show("pledge")      && <TableCell />}
              {show("eaAlign")     && <TableCell />}
              {show("donated")     && (
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
        Underlined values have source citations — hover to view. Ranges reflect uncertainty.
        Pledges are not legally binding.
      </p>
    </div>
  );
}
