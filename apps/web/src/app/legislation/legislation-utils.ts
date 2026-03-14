/**
 * Shared utilities for /legislation routes.
 */
import {
  getTypedEntities,
  getTypedEntityById,
  isPolicy,
  type PolicyEntity,
} from "@/data";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

/**
 * Get all policy entities.
 */
let _cached: PolicyEntity[] | null = null;
export function getPolicyEntities(): PolicyEntity[] {
  if (!_cached) _cached = getTypedEntities().filter(isPolicy);
  return _cached;
}

/**
 * Get all policy slugs for generateStaticParams.
 */
export function getPolicySlugs(): string[] {
  return getPolicyEntities().map((e) => e.id);
}

/**
 * Resolve a policy entity by its slug (entity ID).
 */
export function resolvePolicyBySlug(
  slug: string,
): PolicyEntity | undefined {
  const entity = getTypedEntityById(slug);
  return entity && isPolicy(entity) ? entity : undefined;
}

/**
 * Get a custom field value from a policy entity.
 */
export function getCustomField(
  entity: PolicyEntity,
  label: string,
): string | undefined {
  return entity.customFields.find(
    (f) => f.label.toLowerCase() === label.toLowerCase(),
  )?.value;
}

/**
 * Get the wiki page href for a policy entity.
 */
export function getPolicyWikiHref(entity: PolicyEntity): string | null {
  if (!entity.numericId) return null;
  return getWikiHref(entity.id);
}

/**
 * Get related policies for a given policy.
 */
export function getRelatedPolicies(
  policy: PolicyEntity,
): Array<{ entity: PolicyEntity; relationship?: string }> {
  const allPolicies = getPolicyEntities();
  const relatedIds = new Set(policy.relatedEntries.map((r) => r.id));
  return allPolicies
    .filter((p) => p.id !== policy.id && relatedIds.has(p.id))
    .map((p) => ({
      entity: p,
      relationship: policy.relatedEntries.find((r) => r.id === p.id)
        ?.relationship,
    }));
}

/**
 * Resolve an entity ID to a href, or null if the entity doesn't exist.
 */
export function resolveEntityHref(entityId: string | undefined): string | null {
  if (!entityId) return null;
  const entity = getTypedEntityById(entityId);
  if (!entity) return null;
  return getEntityHref(entityId);
}

/**
 * Derive the effective status string for a policy entity.
 * Checks the typed policyStatus field first (set by build transform),
 * then falls back to inferring from timeline custom fields.
 */
export function deriveStatus(entity: PolicyEntity): string | null {
  if (entity.policyStatus) return entity.policyStatus;
  // Fallback: infer from timeline custom fields
  if (getCustomField(entity, "Vetoed")) return "Vetoed";
  if (getCustomField(entity, "Enacted")) return "Enacted";
  if (getCustomField(entity, "Signed")) return "Enacted";
  if (getCustomField(entity, "In Force") || getCustomField(entity, "Effective")) return "In Effect";
  return null;
}

/** Valid jurisdiction scope values. */
const VALID_SCOPES = new Set(["state", "federal", "international", "national"]);

/** Infer scope from entity tags or ID. Falls back to null if not determinable. */
export function inferScope(tags: string[], id: string): string | null {
  if (tags.includes("state-policy") || id.startsWith("california-") || id.startsWith("colorado-") || id.startsWith("new-york-") || id.startsWith("texas-")) return "State";
  if (tags.includes("federal") || id.startsWith("us-") || id.startsWith("nist-")) return "Federal";
  if (tags.includes("international") || id.startsWith("eu-") || id.includes("international") || id.includes("summits") || id.includes("declaration") || id.includes("convention") || id.includes("consensus")) return "International";
  if (id.startsWith("canada-") || id.startsWith("china-") || id.startsWith("uk-")) return "National";
  return null;
}

/**
 * Get the jurisdiction scope for a policy entity.
 * Uses the typed `scope` field if it's a valid jurisdiction value,
 * otherwise falls back to inference from tags/ID.
 */
export function getPolicyScope(entity: PolicyEntity): string | null {
  // Only use entity.scope if it's a recognized jurisdiction value
  if (entity.scope && VALID_SCOPES.has(entity.scope.toLowerCase())) {
    return entity.scope;
  }
  return inferScope(entity.tags, entity.id);
}
