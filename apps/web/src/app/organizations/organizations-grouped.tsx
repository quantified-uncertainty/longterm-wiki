"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { OrgRow } from "./organizations-table";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";
import { stripMdxEscapes } from "@/lib/inline-markdown";

// ── Column definitions (universal — uses fields available in OrgRow) ─────

interface ColumnDef {
  key: string;
  label: string;
  /** Returns formatted display value, or null when the underlying field is empty. */
  render: (row: OrgRow) => ReactNode | null;
  /** Returns true when this row has data in this column. Drives signal counting. */
  has: (row: OrgRow) => boolean;
}

const COLUMN_DEFS: Record<string, ColumnDef> = {
  valuation: {
    key: "valuation",
    label: "Valuation",
    render: (r) => (r.valuationNum != null ? formatCompactCurrency(r.valuationNum) : null),
    has: (r) => r.valuationNum != null,
  },
  totalFunding: {
    key: "totalFunding",
    label: "Total Funding",
    render: (r) => (r.totalFundingNum != null ? formatCompactCurrency(r.totalFundingNum) : null),
    has: (r) => r.totalFundingNum != null,
  },
  revenue: {
    key: "revenue",
    label: "Revenue",
    render: (r) => (r.revenueNum != null ? formatCompactCurrency(r.revenueNum) : null),
    has: (r) => r.revenueNum != null,
  },
  headcount: {
    key: "headcount",
    label: "Headcount",
    render: (r) => (r.headcount != null ? formatCompactNumber(r.headcount) : null),
    has: (r) => r.headcount != null,
  },
  founded: {
    key: "founded",
    label: "Founded",
    render: (r) => (r.foundedDate ? r.foundedDate.split("-")[0] : null),
    has: (r) => Boolean(r.foundedDate),
  },
};

// ── Group definitions ───────────────────────────────────────────────────

interface GroupDef {
  orgType: string;
  label: string;
  chipLabel: string;
  /** One-line "what is this group and why does it matter" copy. */
  description: string;
  /** Tailwind bg color for the small accent dot in the section header. */
  dotClass: string;
  columns: string[];
}

export const GROUPS: GroupDef[] = [
  {
    orgType: "frontier-lab",
    label: "Frontier AI Labs",
    chipLabel: "Frontier Labs",
    description:
      "Companies training the largest general-purpose AI systems. Their compute scale, model releases, and safety posture set the pace of capability progress.",
    dotClass: "bg-rose-400",
    columns: ["valuation", "headcount", "totalFunding"],
  },
  {
    orgType: "funder",
    label: "Funders & Grantmakers",
    chipLabel: "Funders",
    description:
      "Foundations, philanthropies, and grant programs financing AI safety work — from individual researchers to lab buildouts.",
    dotClass: "bg-amber-400",
    columns: ["totalFunding", "headcount", "founded"],
  },
  {
    orgType: "safety-org",
    label: "Safety & Alignment Orgs",
    chipLabel: "Safety",
    description:
      "Independent organizations doing technical safety, evals, interpretability, or alignment research outside the major labs.",
    dotClass: "bg-emerald-400",
    columns: ["headcount", "totalFunding", "founded"],
  },
  {
    orgType: "academic",
    label: "Academic Groups",
    chipLabel: "Academic",
    description:
      "University labs, centres, and research groups producing publications and training the next generation of safety researchers.",
    dotClass: "bg-indigo-400",
    columns: ["headcount", "founded", "totalFunding"],
  },
  {
    orgType: "government",
    label: "Government & Policy",
    chipLabel: "Government",
    description:
      "Government bodies, AI safety institutes, and policy organizations shaping the regulatory and standards environment.",
    dotClass: "bg-sky-400",
    columns: ["headcount", "totalFunding", "founded"],
  },
  {
    orgType: "startup",
    label: "Startups",
    chipLabel: "Startups",
    description:
      "Early-stage companies building tools, infrastructure, and applications across the AI safety stack.",
    dotClass: "bg-purple-400",
    columns: ["valuation", "headcount", "founded"],
  },
  {
    orgType: "generic",
    label: "Other Organizations",
    chipLabel: "Other",
    description:
      "Other organizations tracked in the knowledge base — companies, nonprofits, and groups adjacent to AI safety.",
    dotClass: "bg-gray-400",
    columns: ["headcount", "totalFunding", "founded"],
  },
];

const KNOWN_TYPES = new Set(GROUPS.map((g) => g.orgType));
const FALLBACK_TYPE = "generic";

const MAX_FEATURED = 10;
const MAX_TRAILING_NAMES = 8;

// ── Featured ranking ────────────────────────────────────────────────────

/** Counts data signals visible in this group's row layout (rendered cells + description). */
function rowSignalCount(row: OrgRow, columns: ColumnDef[]): number {
  let n = 0;
  for (const col of columns) {
    if (col.has(row)) n++;
  }
  if (row.description && row.description.trim().length > 0) n += 0.5;
  return n;
}

function compareForFeatured(
  a: OrgRow,
  b: OrgRow,
  columns: ColumnDef[],
): number {
  const aSig = rowSignalCount(a, columns);
  const bSig = rowSignalCount(b, columns);
  if (bSig !== aSig) return bSig - aSig;
  if (b.completionScore !== a.completionScore) {
    return b.completionScore - a.completionScore;
  }
  return a.name.localeCompare(b.name);
}

export function splitFeatured(
  orgs: OrgRow[],
  columns: ColumnDef[],
): { featured: OrgRow[]; trailing: OrgRow[] } {
  const sorted = [...orgs].sort((a, b) => compareForFeatured(a, b, columns));
  // Anything with at least *some* signal (a rendered cell or a description)
  // is eligible to be featured. Totally blank stubs sink to the trailing list.
  const wellOrganized = sorted.filter(
    (o) => rowSignalCount(o, columns) > 0,
  );
  const featured = wellOrganized.slice(0, MAX_FEATURED);
  // If absolutely nothing has any data, surface a small handful so the section
  // isn't blank — the section header's coverage badges signal this honestly.
  const finalFeatured =
    featured.length > 0 ? featured : sorted.slice(0, Math.min(4, sorted.length));
  const featuredIds = new Set(finalFeatured.map((o) => o.id));
  const trailing = sorted.filter((o) => !featuredIds.has(o.id));
  return { featured: finalFeatured, trailing };
}

// ── Bucketing ───────────────────────────────────────────────────────────

export function bucketOrgs(rows: OrgRow[]): Map<string, OrgRow[]> {
  const byType = new Map<string, OrgRow[]>();
  for (const row of rows) {
    const t =
      row.orgType && KNOWN_TYPES.has(row.orgType) ? row.orgType : FALLBACK_TYPE;
    const arr = byType.get(t) ?? [];
    arr.push(row);
    byType.set(t, arr);
  }
  return byType;
}

// ── Components ──────────────────────────────────────────────────────────

export interface OrganizationsGroupedProps {
  rows: OrgRow[];
  /** Called when the user clicks "view all" in a section's trailing footer. */
  onViewAll?: (orgType: string) => void;
}

export function OrganizationsGrouped({ rows, onViewAll }: OrganizationsGroupedProps) {
  const byType = bucketOrgs(rows);

  return (
    <div className="space-y-6">
      {GROUPS.map((group) => {
        const orgs = byType.get(group.orgType);
        if (!orgs || orgs.length === 0) return null;
        return (
          <OrgGroupSection
            key={group.orgType}
            group={group}
            orgs={orgs}
            onViewAll={onViewAll}
          />
        );
      })}
    </div>
  );
}

function OrgGroupSection({
  group,
  orgs,
  onViewAll,
}: {
  group: GroupDef;
  orgs: OrgRow[];
  onViewAll?: (orgType: string) => void;
}) {
  const columns = group.columns
    .map((c) => COLUMN_DEFS[c])
    .filter((c): c is ColumnDef => Boolean(c));
  const { featured, trailing } = splitFeatured(orgs, columns);

  return (
    <section
      id={`group-${group.orgType}`}
      aria-labelledby={`group-${group.orgType}-h`}
      className="scroll-mt-32"
    >
      {/* Slim single-row header: title block + description (truncated) + coverage + view-all */}
      <header className="rounded-t-xl border border-border bg-muted/30 px-4 py-1.5 flex items-center gap-x-3 min-h-[34px]">
        {/* Title cluster — never shrinks, never wraps */}
        <div className="flex items-baseline gap-2 flex-none whitespace-nowrap">
          <span
            className={`inline-block w-2 h-2 rounded-full translate-y-[1px] ${group.dotClass}`}
            aria-hidden="true"
          />
          <h2
            id={`group-${group.orgType}-h`}
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            {group.label}
          </h2>
          <span className="text-[11px] text-muted-foreground/80 tabular-nums">
            {orgs.length} · {featured.length} featured
          </span>
        </div>
        {/* Description — fills remaining space, truncates to one line */}
        <p className="text-xs text-muted-foreground/80 truncate flex-1 min-w-0 leading-snug hidden md:block">
          {group.description}
        </p>
        {/* View-all link */}
        {onViewAll && trailing.length > 0 && (
          <button
            type="button"
            onClick={() => onViewAll(group.orgType)}
            className="text-[11px] text-primary hover:underline underline-offset-2 whitespace-nowrap flex-none"
          >
            View all {orgs.length} →
          </button>
        )}
      </header>

      {/* Featured rows */}
      <ul className="rounded-b-xl border border-t-0 border-border bg-card divide-y divide-border/40 overflow-hidden">
        {featured.map((row) => (
          <FeaturedRow key={row.id} row={row} columns={columns} />
        ))}
      </ul>

      {/* Trailing list */}
      {trailing.length > 0 && (
        <TrailingList
          trailing={trailing}
          orgType={group.orgType}
          onViewAll={onViewAll}
        />
      )}
    </section>
  );
}

function FeaturedRow({
  row,
  columns,
}: {
  row: OrgRow;
  columns: ColumnDef[];
}) {
  return (
    <li className="grid grid-cols-[minmax(260px,2.6fr)_repeat(3,minmax(80px,0.8fr))_auto] items-start gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/20 transition-colors">
      {/* Name + description */}
      <div className="min-w-0">
        <Link
          href={`/organizations/${row.slug ?? row.id}`}
          className="font-medium text-foreground hover:text-primary transition-colors"
        >
          {row.name}
        </Link>
        {row.description && (
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2 leading-snug">
            {stripMdxEscapes(row.description)}
          </p>
        )}
      </div>
      {/* Per-type columns (always 3) */}
      {[0, 1, 2].map((i) => {
        const col = columns[i];
        if (!col) return <div key={i} aria-hidden="true" />;
        const value = col.render(row);
        return (
          <div key={col.key}>
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-0.5">
              {col.label}
            </div>
            {value != null ? (
              <div className="font-semibold tabular-nums text-sm">{value}</div>
            ) : (
              <div className="text-muted-foreground/40 text-sm">{"\u2014"}</div>
            )}
          </div>
        );
      })}
      {/* Coverage dots */}
      <div className="ml-2 pt-0.5">
        <RecordStatusDots
          coverageScore={row.completionScore}
          verdict={row.verdictString}
        />
      </div>
    </li>
  );
}

function TrailingList({
  trailing,
  orgType,
  onViewAll,
}: {
  trailing: OrgRow[];
  orgType: string;
  onViewAll?: (orgType: string) => void;
}) {
  const visibleNames = trailing.slice(0, MAX_TRAILING_NAMES);
  const remaining = trailing.length - visibleNames.length;

  return (
    <div className="mt-2 px-5 py-2 text-xs text-muted-foreground/90 leading-relaxed">
      <span className="text-muted-foreground/60 mr-2">Also:</span>
      {visibleNames.map((row, i) => (
        <span key={row.id}>
          <Link
            href={`/organizations/${row.slug ?? row.id}`}
            className="hover:text-primary transition-colors hover:underline underline-offset-2"
          >
            {row.name}
          </Link>
          {i < visibleNames.length - 1 ? ", " : ""}
        </span>
      ))}
      {remaining > 0 && onViewAll ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() => onViewAll(orgType)}
            className="text-primary hover:underline underline-offset-2"
          >
            …and {remaining} more →
          </button>
        </>
      ) : remaining > 0 ? (
        <span className="italic"> …and {remaining} more</span>
      ) : null}
    </div>
  );
}
