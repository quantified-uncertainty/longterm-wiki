/**
 * Shared UI components and helpers for record detail pages
 * (grants, funding-rounds, investments, divisions, funding-programs).
 */
import Link from "next/link";
import { getKBEntity, getKBEntitySlug } from "@/data/factbase";
import { getTypedEntityById, getIdRegistry } from "@/data";
import { titleCase } from "@/components/wiki/factbase/format";

/**
 * Build a { name, href } result from a typed entity and its slug.
 */
function buildEntityResult(
  entity: { entityType: string; title: string; wikiId?: string },
  slug: string,
): { name: string; href: string | null } {
  if (entity.entityType === "organization")
    return { name: entity.title, href: `/organizations/${slug}` };
  if (entity.entityType === "person")
    return { name: entity.title, href: `/people/${slug}` };
  return {
    name: entity.title,
    href: entity.wikiId ? `/wiki/${entity.wikiId}` : null,
  };
}

/**
 * Try to resolve an entity through the TableBase (typed entities in database.json).
 * Handles three cases that FactBase cannot resolve:
 * 1. Bare numeric IDs (e.g. "175") - legacy wiki page IDs from PG, resolved via E-number lookup
 * 2. StableIds (e.g. "8grDoD8kig") - entities that exist in YAML but not in FactBase,
 *    resolved via the stableIdToSlug mapping in the id registry
 * 3. Direct slug matches - entityIds that happen to be entity slugs
 */
function resolveViaTableBase(
  entityId: string,
): { name: string; href: string | null } | null {
  const registry = getIdRegistry();

  // Case 1: bare numeric ID -> try as wiki page ID (E-number)
  if (/^\d+$/.test(entityId)) {
    const slug = registry.byWikiId[`E${entityId}`];
    if (slug) {
      const entity = getTypedEntityById(slug);
      if (entity) return buildEntityResult(entity, slug);
    }
  }

  // Case 2: stableId -> look up in the stableIdToSlug mapping from the id registry
  if (registry.stableIdToSlug) {
    const slugFromStableId = registry.stableIdToSlug[entityId];
    if (slugFromStableId) {
      const entity = getTypedEntityById(slugFromStableId);
      if (entity) return buildEntityResult(entity, slugFromStableId);
    }
  }

  // Case 3: try direct TableBase lookup (entityId might already be a slug)
  const directEntity = getTypedEntityById(entityId);
  if (directEntity) return buildEntityResult(directEntity, directEntity.id);

  return null;
}

/**
 * Check whether an ID looks like a raw internal identifier that should not be
 * displayed to users (bare numbers, 10-char alphanumeric stableIds).
 */
function isRawInternalId(id: string): boolean {
  return /^\d+$/.test(id) || /^[A-Za-z0-9]{10}$/.test(id);
}

/**
 * Resolve a KB entity ID to a display name and optional href.
 * Tries FactBase first, then falls back to TableBase for entities that only
 * exist in YAML (not in FactBase) or use legacy numeric wiki page IDs.
 */
export function resolveEntityLink(
  entityId: string,
): { name: string; href: string | null } {
  // Primary: try FactBase (handles 10-char entity IDs and slugs)
  const entity = getKBEntity(entityId);
  if (entity) {
    const slug = getKBEntitySlug(entityId);
    if (slug) {
      if (entity.type === "organization")
        return { name: entity.name, href: `/organizations/${slug}` };
      if (entity.type === "person")
        return { name: entity.name, href: `/people/${slug}` };
    }
    return { name: entity.name, href: `/factbase/entity/${entityId}` };
  }

  // Fallback: try TableBase (handles bare numeric IDs and stableIds not in FactBase)
  const tableBaseResult = resolveViaTableBase(entityId);
  if (tableBaseResult) return tableBaseResult;

  // Last resort: if the ID looks like an internal ID, show "Unknown" instead of the raw value
  if (isRawInternalId(entityId)) {
    return { name: "Unknown", href: null };
  }

  return { name: titleCase(entityId.replace(/-/g, " ")), href: null };
}

/** Badge color maps shared across funding-round and investment detail pages. */
export const INSTRUMENT_COLORS: Record<string, string> = {
  equity:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "convertible-note":
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  safe: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  debt: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  grant:
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
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
  return (
    <span className="text-sm font-medium text-foreground">{name}</span>
  );
}
