/**
 * Section components for division detail pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { titleCase } from "@/components/wiki/kb/format";

import type {
  ParsedDivisionPersonnel,
  ParsedFundingProgram,
  ParsedDivisionGrant,
} from "./division-data";
import {
  PROGRAM_TYPE_LABELS,
  PROGRAM_TYPE_COLORS,
} from "./division-data";

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
              <th className="text-left py-2 px-3 font-medium">Name</th>
              <th className="text-left py-2 px-3 font-medium">Role</th>
              <th className="text-center py-2 px-3 font-medium">Dates</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {personnel.map((p) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Funding Programs Section ─────────────────────────────────────────

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
              <th className="text-left py-2 px-3 font-medium">Program</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-right py-2 px-3 font-medium">Budget</th>
              <th className="text-center py-2 px-3 font-medium">Status</th>
              <th className="text-center py-2 px-3 font-medium">Deadline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {programs.map((p) => (
              <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <Link
                    href={`/funding-programs/${p.key}`}
                    className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      PROGRAM_TYPE_COLORS[p.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {PROGRAM_TYPE_LABELS[p.programType] ?? p.programType}
                  </span>
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {p.totalBudget != null && (
                    <span className="font-semibold">{formatCompactCurrency(p.totalBudget)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-xs">
                  {p.status && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        p.status === "open"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : p.status === "awarded"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {titleCase(p.status)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {p.deadline ?? p.openDate ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Grants Section ──────────────────────────────────────────────────

export function DivisionGrantsSection({
  grants,
}: {
  grants: ParsedDivisionGrant[];
}) {
  if (grants.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">Grants</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {grants.length}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">Recipient</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => (
              <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {g.name}
                  </span>
                </td>
                <td className="py-2 px-3 text-xs">
                  {g.recipientHref ? (
                    <Link
                      href={g.recipientHref}
                      className="text-primary hover:underline"
                    >
                      {g.recipientName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{g.recipientName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {g.amount != null && (
                    <span className="font-semibold">
                      {formatCompactCurrency(g.amount)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
