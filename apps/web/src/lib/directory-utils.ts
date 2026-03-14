/**
 * Shared utilities for entity directory and profile pages (/people, /organizations).
 * NOTE: This file imports server-only modules (@/data/kb). Do NOT import from client components.
 * For client-safe formatting, import from @/lib/format-compact instead.
 */

import {
  getKBEntity,
  getKBEntitySlug,
  getKBSlugMap,
  getKBEntities,
  resolveKBSlug,
} from "@/data/kb";
import { formatKBDate } from "@/components/wiki/kb/format";
import type { Entity } from "@longterm-wiki/kb";
import { getTypedEntities, isPerson, isRisk, isOrganization } from "@/data";

import { formatCompactCurrency } from "@/lib/format-compact";

// Re-export client-safe formatting for convenience in server components
export { formatCompactCurrency, formatCompactNumber, safeHref } from "@/lib/format-compact";

// Re-export from format.ts so server consumers don't need two imports
export { isUrl, shortDomain, formatKBDate } from "@/components/wiki/kb/format";

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
  // Try as entity ID first, then as slug
  let entity = getKBEntity(ref);
  if (!entity) {
    const entityId = resolveKBSlug(ref);
    if (entityId) entity = getKBEntity(entityId);
  }
  if (!entity) return { name: ref, id: ref, slug: undefined };
  return {
    name: entity.name,
    id: entity.id,
    slug: getKBEntitySlug(entity.id) ?? undefined,
  };
}

/** Get the wiki page href for an entity, or null if no wiki page. */
export function getEntityWikiHref(entity: Entity): string | null {
  if (entity.numericId) return `/wiki/${entity.numericId}`;
  if (entity.wikiPageId) return `/wiki/${entity.wikiPageId}`;
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
): Entity | undefined {
  const entityId = resolveKBSlug(slug);
  if (!entityId) return undefined;
  const entity = getKBEntity(entityId);
  if (!entity || entity.type !== type) return undefined;
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
