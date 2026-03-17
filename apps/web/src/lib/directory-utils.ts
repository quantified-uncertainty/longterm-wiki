/**
 * Shared utilities for entity directory and profile pages (/people, /organizations).
 * NOTE: This file imports server-only modules (@/data/factbase). Do NOT import from client components.
 * For client-safe formatting, import from @/lib/format-compact instead.
 */

import {
  getKBSlugMap,
  getKBEntities,
  resolveKBSlug,
} from "@/data/factbase";
import { formatKBDate } from "@/components/wiki/factbase/format";
import { getTypedEntities, getTypedEntityById, isPerson, isRisk, isOrganization, type AnyEntity } from "@/data";

import { formatCompactCurrency } from "@/lib/format-compact";

// Re-export client-safe formatting for convenience in server components
export { formatCompactCurrency, formatCompactNumber, safeHref } from "@/lib/format-compact";

// Re-export from format.ts so server consumers don't need two imports
export { isUrl, shortDomain, formatKBDate } from "@/components/wiki/factbase/format";

// ── Currency formatting (server-only, handles unknown input) ────

/**
 * Format a numeric value as compact currency from unknown input.
 * Handles string → number coercion. For client components, use formatCompactCurrency from format-compact.
 */
export function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  return formatCompactCurrency(num);
}

// ── Entity resolution ───────────────────────────────────────────

export interface ResolvedEntity {
  name: string;
  id: string;
  slug: string | undefined;
}

/**
 * Resolve an entity reference (slug or entity ID) to name + id + slug.
 * Returns null if the ref is empty, or a best-effort result with the raw ref as name.
 */
export function resolveEntityRef(ref: unknown): ResolvedEntity | null {
  if (typeof ref !== "string" || !ref) return null;
  // Try TableBase first (handles slugs, E-numbers, and 10-char stableIds)
  const entity = getTypedEntityById(ref);
  if (entity) {
    return {
      name: entity.title,
      id: entity.stableId ?? entity.id,
      slug: entity.id, // entity.id is the slug in TableBase
    };
  }
  // Fallback: try resolving as a FactBase slug
  const entityId = resolveKBSlug(ref);
  if (entityId) {
    const resolved = getTypedEntityById(entityId);
    if (resolved) {
      return {
        name: resolved.title,
        id: resolved.stableId ?? resolved.id,
        slug: resolved.id,
      };
    }
  }
  return { name: ref, id: ref, slug: undefined };
}

/** Get the wiki page href for an entity, or null if no wiki page. */
export function getEntityWikiHref(entity: { wikiId?: string }): string | null {
  if (entity.wikiId) return `/wiki/${entity.wikiId}`;
  return null;
}

// ── Slug utilities ──────────────────────────────────────────────

/**
 * Resolve a URL slug to a KB entity of a specific type.
 * Generic version of resolveOrgBySlug / resolvePersonBySlug.
 */
export function resolveEntityBySlug(
  slug: string,
  type: "person" | "organization" | "risk",
): AnyEntity | undefined {
  // Try TableBase first (slug is the primary key for typed entities)
  const directEntity = getTypedEntityById(slug);
  if (directEntity && directEntity.entityType === type) return directEntity;
  // Fallback: try resolving as a FactBase slug -> stableId -> TableBase
  const entityId = resolveKBSlug(slug);
  if (!entityId) return undefined;
  const entity = getTypedEntityById(entityId);
  if (!entity || entity.entityType !== type) return undefined;
  return entity;
}

/** Type guard filter for typed entities by directory type. */
const TYPE_FILTERS: Record<string, (e: { entityType: string }) => boolean> = {
  person: (e) => isPerson(e as Parameters<typeof isPerson>[0]),
  risk: (e) => isRisk(e as Parameters<typeof isRisk>[0]),
  organization: (e) => isOrganization(e as Parameters<typeof isOrganization>[0]),
};

/**
 * Get all slugs for entities of a given type (for generateStaticParams).
 *
 * Sources ALL entities — both KB-backed (slug map) and entity YAML
 * (typed entities). This ensures every entity in the directory listing
 * has a corresponding detail page.
 */
export function getEntitySlugs(type: "person" | "organization" | "risk"): string[] {
  const allSlugs = new Set<string>();

  // KB-backed slugs (from slug map)
  const slugMap = getKBSlugMap();
  const kbEntities = getKBEntities();
  const kbIds = new Set(
    kbEntities.filter((e) => e.type === type).map((e) => e.id),
  );
  for (const [slug, id] of Object.entries(slugMap)) {
    if (kbIds.has(id)) allSlugs.add(slug);
  }

  // Entity YAML slugs (typed entities from database.json)
  const filter = TYPE_FILTERS[type];
  if (filter) {
    for (const e of getTypedEntities()) {
      if (filter(e)) allSlugs.add(e.id);
    }
  }

  return [...allSlugs];
}

// ── Date formatting ─────────────────────────────────────────────

/** Format a date range as "Jun 2020 – present" or "Jun 2020 – Dec 2023". */
export function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start && !end) return "";
  const startStr = start ? formatKBDate(start) : "";
  const endStr = end ? formatKBDate(end) : start ? "present" : "";
  if (!startStr && endStr) return endStr;
  if (startStr && !endStr) return startStr;
  return `${startStr} \u2013 ${endStr}`;
}

/** Extract a string field value from a record, returning null if missing. */
export function fieldStr(
  fields: Record<string, unknown>,
  key: string,
): string | null {
  const v = fields[key];
  return v != null ? String(v) : null;
}
