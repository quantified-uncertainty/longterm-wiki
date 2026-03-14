/**
 * Shared components and helpers used across organization profile sections.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import type { KBRecordEntry } from "@/data/kb";
import {
  formatKBDate,
  titleCase,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";
import {
  resolveKBSlug,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/kb";
import { safeHref } from "@/lib/format-compact";

// Re-export so existing consumers of { safeHref } from "./org-shared" keep working.
export { safeHref };

// ── Formatting helpers ────────────────────────────────────────────────

/** Safely get a string field from a record, or undefined. */
export function field(item: KBRecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

// ── Entity ref resolver helper ────────────────────────────────────────

export function resolveRefName(
  slug: string | undefined,
  displayName: string | undefined,
): { name: string; href: string | null } {
  if (!slug && !displayName) return { name: "Unknown", href: null };

  if (slug) {
    const entityId = resolveKBSlug(slug);
    const entity = entityId ? getKBEntity(entityId) : null;
    if (entity) {
      const prefix = entity.type === "organization" ? "/organizations"
        : entity.type === "person" ? "/people"
        : null;
      return { name: entity.name, href: prefix ? `${prefix}/${slug}` : `/kb/entity/${entityId}` };
    }
  }

  // Fall back to display name or humanized slug
  const fallbackName = displayName ?? (slug ? titleCase(slug) : "Unknown");
  return { name: fallbackName, href: null };
}

/** Resolve a recipient slug/ID to a display name and optional href. */
export function resolveRecipient(recipientId: string): { name: string; href: string | null } {
  const entity = getKBEntity(recipientId);
  if (entity) {
    const slug = getKBEntitySlug(recipientId);
    const href = slug && entity.type === "organization" ? `/organizations/${slug}`
      : slug && entity.type === "person" ? `/people/${slug}`
      : `/kb/entity/${recipientId}`;
    return { name: entity.name, href };
  }
  // Fall back: titleCase the slug
  return { name: titleCase(recipientId.replace(/-/g, " ")), href: null };
}

// ── Subcomponents ─────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>
      )}
    </div>
  );
}

/** Section header with optional count badge and divider. */
export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" aria-hidden="true" />
    </div>
  );
}

/** Source link for a record entry. */
export function SourceLink({ source }: { source: string | undefined }) {
  if (!source) return null;
  if (isUrl(source)) {
    return (
      <a
        href={safeHref(source)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-primary/70 hover:text-primary hover:underline transition-colors"
      >
        {shortDomain(source)}
        <span className="sr-only"> (opens in new tab)</span>
      </a>
    );
  }
  return <span className="text-[11px] text-muted-foreground">{source}</span>;
}

/** Compact unified people table with tags inline next to name. */
export function PeopleTable({
  people,
}: {
  people: Array<{
    name: string;
    title?: string;
    slug?: string;
    entityType?: string;
    isFounder?: boolean;
    isBoard?: boolean;
    isCurrent?: boolean;
    start?: string;
    end?: string;
  }>;
}) {
  if (people.length === 0) return null;

  return (
    <div className="border border-border rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
            <th scope="col" className="py-2 px-3 text-left font-medium">Name</th>
            <th scope="col" className="py-2 px-3 text-left font-medium">Role</th>
            <th scope="col" className="py-2 px-3 text-left font-medium">Tenure</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {people.map((person, i) => {
            const href = person.slug && person.entityType
              ? person.entityType === "organization"
                ? `/organizations/${person.slug}`
                : `/people/${person.slug}`
              : undefined;

            const tenure = person.start
              ? `${formatKBDate(person.start)}${person.end ? ` \u2013 ${formatKBDate(person.end)}` : " \u2013 present"}`
              : "";

            const isFormer = person.isCurrent === false;
            const hasTags = person.isFounder || person.isBoard;

            return (
              <tr key={`${person.name}-${i}`} className={`hover:bg-muted/20 transition-colors${isFormer ? " opacity-60" : ""}`}>
                <td className="py-1.5 px-3">
                  <span className="flex items-center gap-1.5">
                    {href ? (
                      <Link href={href} className="font-medium text-foreground hover:text-primary transition-colors">
                        {person.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{person.name}</span>
                    )}
                    {hasTags && (
                      <>
                        {person.isFounder && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            Founder
                          </span>
                        )}
                        {person.isBoard && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                            Board
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </td>
                <td className="py-1.5 px-3 text-muted-foreground">{person.title ?? ""}</td>
                <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap text-xs">{tenure}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Badge({ children, color }: { children: React.ReactNode; color?: string }) {
  const colorClass =
    color ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] font-semibold ${colorClass}`}
    >
      {children}
    </span>
  );
}
