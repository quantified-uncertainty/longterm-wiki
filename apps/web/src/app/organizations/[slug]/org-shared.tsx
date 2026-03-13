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
import { safeHref } from "@/lib/directory-utils";

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

export function PersonRow({
  name,
  title,
  slug,
  entityType,
  isFounder,
  start,
  end,
  notes,
}: {
  name: string;
  title?: string;
  slug?: string;
  entityType?: string;
  isFounder?: boolean;
  start?: string;
  end?: string;
  notes?: string;
}) {
  const href = slug && entityType
    ? entityType === "organization"
      ? `/organizations/${slug}`
      : `/people/${slug}`
    : undefined;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/40 last:border-b-0">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs font-semibold text-primary/70 mt-0.5" aria-hidden="true">
        {name
          .split(/\s+/)
          .map((w) => w[0])
          .filter(Boolean)
          .slice(0, 2)
          .join("")
          .toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {href ? (
            <Link
              href={href}
              className="font-semibold text-sm hover:text-primary transition-colors"
            >
              {name}
            </Link>
          ) : (
            <span className="font-semibold text-sm">{name}</span>
          )}
          {isFounder && (
            <span className="px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              Founder
            </span>
          )}
        </div>
        {title && (
          <div className="text-xs text-muted-foreground">{title}</div>
        )}
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {start && formatKBDate(start)}
          {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
        </div>
        {notes && (
          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
            {notes}
          </div>
        )}
      </div>
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
