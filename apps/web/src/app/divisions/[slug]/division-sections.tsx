/**
 * Section components for division detail pages.
 */
import Link from "next/link";

import type { ParsedDivisionPersonnel, ParsedFundingProgram, SiblingDivision } from "./division-data";
import {
  DIVISION_TYPE_LABELS,
  DIVISION_TYPE_COLORS,
} from "../division-constants";
import {
  titleCase,
} from "@/components/wiki/factbase/format";
import { formatCompactCurrency } from "@/lib/format-compact";
import { getRecordVerdict } from "@data/tablebase";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

// ── Team Members Section ─────────────────────────────────────────────

export function TeamMembersSection({
  personnel,
}: {
  personnel: ParsedDivisionPersonnel[];
}) {
  if (personnel.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">Team Members</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {personnel.length}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Name</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Role</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Dates</th>
              <th scope="col" className="py-2 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {personnel.map((p) => {
              const verdict = getRecordVerdict("personnel", String(p.key))?.verdict;
              return (
                <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    {p.personHref ? (
                      <Link
                        href={p.personHref}
                        className="font-medium text-primary text-xs hover:underline"
                      >
                        {p.personName}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground text-xs">
                        {p.personName}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {p.role}
                  </td>
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                    {p.startDate && (
                      <span>
                        {p.startDate}
                        {p.endDate ? ` - ${p.endDate}` : " - present"}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-1">
                    <SourcingDot
                      status={recordVerdictToStatus(verdict)}
                      originalVerdict={verdict}
                      size="md"
                      href={verdict ? getSourcingHref("personnel", String(p.key)) : undefined}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Funding Programs Section ─────────────────────────────────────

export function FundingProgramsSection({
  programs,
}: {
  programs: ParsedFundingProgram[];
}) {
  if (programs.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">Funding Programs</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {programs.length}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Program</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Type</th>
              <th scope="col" className="text-right py-2 px-3 font-medium">Budget</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Status</th>
              <th scope="col" className="py-2 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {programs.map((p) => {
              const verdict = getRecordVerdict("funding-program", String(p.key))?.verdict;
              return (
                <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <span className="font-medium text-foreground text-xs">
                      {p.name}
                    </span>
                    {p.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {p.description}
                      </p>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground whitespace-nowrap">
                    {titleCase(p.programType)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {p.totalBudget != null && (
                      <span className="font-semibold">
                        {formatCompactCurrency(p.totalBudget)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center text-xs">
                    {p.status && (
                      <span className="text-muted-foreground">
                        {titleCase(p.status)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-1">
                    <SourcingDot
                      status={recordVerdictToStatus(verdict)}
                      originalVerdict={verdict}
                      size="md"
                      href={verdict ? getSourcingHref("funding-program", String(p.key)) : undefined}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Sibling Divisions Section ────────────────────────────────────

export function SiblingDivisionsSection({
  siblings,
  parentName,
}: {
  siblings: SiblingDivision[];
  parentName: string;
}) {
  if (siblings.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">
          Other {parentName} Divisions
        </h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {siblings.length}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="flex flex-wrap gap-2">
        {siblings.map((s) => (
          <div key={s.key} className="inline-flex items-center gap-1.5">
            {s.href ? (
              <Link
                href={s.href}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
              >
                <span>{s.name}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                    DIVISION_TYPE_COLORS[s.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  }`}
                >
                  {DIVISION_TYPE_LABELS[s.divisionType] ?? titleCase(s.divisionType)}
                </span>
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 text-xs font-medium text-muted-foreground">
                <span>{s.name}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                    DIVISION_TYPE_COLORS[s.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  }`}
                >
                  {DIVISION_TYPE_LABELS[s.divisionType] ?? titleCase(s.divisionType)}
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Back to Parent Link ──────────────────────────────────────────────

export function BackToParentLink({
  parent,
}: {
  parent: { name: string; href: string | null };
}) {
  return (
    <div className="mt-8 pt-6 border-t border-border/60">
      {parent.href ? (
        <Link
          href={parent.href}
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to {parent.name}
        </Link>
      ) : (
        <Link
          href="/organizations"
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to organizations
        </Link>
      )}
    </div>
  );
}
