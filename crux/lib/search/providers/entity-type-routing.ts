/**
 * Entity-Type Routing — maps entity types to active search providers.
 *
 * Baseline providers (Exa, Perplexity, SCRY) always run regardless of entity type.
 * Domain-specific providers only activate when the entity type matches their
 * expertise, avoiding unnecessary API calls for unrelated page types.
 */

/** Provider names that can be activated by entity type. */
export type DomainProvider = 'github' | 'semantic-scholar' | 'federal-register';

/**
 * Routing table: entity type → set of domain-specific providers.
 *
 * Only entity types with at least one domain provider are listed.
 * All unlisted types get no domain-specific providers (baseline only).
 */
const ROUTING_TABLE: Record<string, DomainProvider[]> = {
  organization: ['github'],
  person: ['semantic-scholar'],
  project: ['github'],
  'ai-model': ['github', 'semantic-scholar'],
  policy: ['federal-register'],
  concept: ['semantic-scholar'],
  approach: ['semantic-scholar'],
  benchmark: ['github', 'semantic-scholar'],
};

/**
 * Get the set of domain-specific providers to activate for a given entity type.
 *
 * @param entityType - The entity type string (e.g. 'organization', 'person')
 * @returns Array of provider names to activate (may be empty)
 */
export function getActiveProviders(entityType?: string): DomainProvider[] {
  if (!entityType) return [];
  return ROUTING_TABLE[entityType] ?? [];
}

/**
 * Check whether a specific domain provider should be active for an entity type.
 */
export function isProviderActiveForType(provider: DomainProvider, entityType?: string): boolean {
  return getActiveProviders(entityType).includes(provider);
}
