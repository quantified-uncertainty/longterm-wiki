/**
 * Section components for division detail pages.
 */
import Link from "next/link";

import type { ParsedDivisionPersonnel } from "./division-data";

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
