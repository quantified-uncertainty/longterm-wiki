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
 * Maps legacy/alias entity type names to canonical names used in ROUTING_TABLE.
 * Kept in sync with ENTITY_TYPE_ALIASES from apps/web/src/data/entity-type-names.ts.
 */
const ENTITY_TYPE_ALIASES: Record<string, string> = {
  researcher: 'person',
  lab: 'organization',
  'lab-frontier': 'organization',
  'lab-research': 'organization',
  'lab-startup': 'organization',
  'lab-academic': 'organization',
  funder: 'organization',
  policies: 'policy',
  concepts: 'concept',
  events: 'event',
  models: 'ai-model',
  'research-area': 'approach',
};

/**
 * Get the set of domain-specific providers to activate for a given entity type.
 * Normalizes legacy/alias entity type names to their canonical equivalents.
 *
 * @param entityType - The entity type string (e.g. 'organization', 'person', 'lab')
 * @returns Array of provider names to activate (may be empty)
 */
export function getActiveProviders(entityType?: string): DomainProvider[] {
  if (!entityType) return [];
  const normalized = ENTITY_TYPE_ALIASES[entityType] ?? entityType;
  return [...(ROUTING_TABLE[normalized] ?? [])];
}

/**
 * Check whether a specific domain provider should be active for an entity type.
 */
export function isProviderActiveForType(provider: DomainProvider, entityType?: string): boolean {
  return getActiveProviders(entityType).includes(provider);
}
