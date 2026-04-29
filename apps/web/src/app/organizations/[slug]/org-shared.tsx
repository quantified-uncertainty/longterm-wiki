/**
 * Shared components and helpers used across organization profile sections.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import type { KBRecordEntry } from "@/data/factbase";
import {
  shortDomain,
  isUrl,
} from "@/components/wiki/factbase/format";
import { safeHref } from "@/lib/format-compact";
import { resolveEntityName } from "@/lib/resolve-entity-name";

// Re-export so existing consumers keep working.
export { safeHref, resolveEntityName };

// ── Formatting helpers ────────────────────────────────────────────────

/** Safely get a string field from a record, or undefined. */
export function field(item: KBRecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

// ── Entity ref resolver helpers (delegate to shared resolver) ─────────

/** @deprecated Use resolveEntityName directly */
export function resolveRefName(
  slugOrId: string | undefined,
  displayName: string | undefined,
): { name: string; href: string | null } {
  return resolveEntityName(slugOrId, displayName);
}

/** @deprecated Use resolveEntityName directly */
export function resolveRecipient(recipientId: string): { name: string; href: string | null } {
  return resolveEntityName(recipientId);
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
    <div
      data-testid="stat-card"
      className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
    >
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
