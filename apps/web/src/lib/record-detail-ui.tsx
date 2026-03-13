/**
 * Shared UI components and helpers for record detail pages
 * (grants, funding-rounds, investments, divisions, funding-programs).
 */
import Link from "next/link";
import {
  getKBEntity,
  getKBEntitySlug,
} from "@/data/kb";
import { titleCase } from "@/components/wiki/kb/format";

/**
 * Resolve a KB entity ID to a display name and optional href.
 * Equivalent to `resolveRecipient` in org-shared.tsx.
 */
export function resolveEntityLink(entityId: string): { name: string; href: string | null } {
  const entity = getKBEntity(entityId);
  if (entity) {
    const slug = getKBEntitySlug(entityId);
    if (slug) {
      if (entity.type === "organization") return { name: entity.name, href: `/organizations/${slug}` };
      if (entity.type === "person") return { name: entity.name, href: `/people/${slug}` };
    }
    return { name: entity.name, href: `/kb/entity/${entityId}` };
  }
  return { name: titleCase(entityId.replace(/-/g, " ")), href: null };
}

/** Badge color maps shared across funding-round and investment detail pages. */
export const INSTRUMENT_COLORS: Record<string, string> = {
  equity: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "convertible-note": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  safe: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  debt: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  grant: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

/** Label + children layout for detail page fields. */
export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
        {title}
      </div>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

/** Entity name that links to its page if an href exists, plain text otherwise. */
export function EntityLinkDisplay({
  name,
  href,
}: {
  name: string;
  href: string | null;
}) {
  if (href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-primary hover:underline"
      >
        {name}
      </Link>
    );
  }
  return <span className="text-sm font-medium text-foreground">{name}</span>;
}
