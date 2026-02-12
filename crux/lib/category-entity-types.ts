/**
 * Category → EntityType mapping
 *
 * Maps content directory categories to their default entityType.
 * Used by the page-creator pipeline to auto-set entityType in frontmatter
 * so the build-data frontmatter scanner can create auto-entities.
 *
 * Categories listed in ENTITY_REQUIRED_CATEGORIES (validate-entities.test.ts)
 * MUST have a mapping here so pages deployed to them pass CI.
 */

/** Default entityType for each content category directory */
export const CATEGORY_ENTITY_TYPES: Record<string, string> = {
  // Entity-required categories (CI test enforces entity existence)
  people: 'person',
  organizations: 'organization',
  risks: 'risk',
  responses: 'approach',
  models: 'model',
  worldviews: 'concept',
  'intelligence-paradigms': 'intelligence-paradigm',

  // Other categories with natural entity type mappings
  capabilities: 'capability',
  cruxes: 'crux',
  debates: 'debate',
  incidents: 'event',
  forecasting: 'project',
  metrics: 'metric',
};

/**
 * Infer entityType from a destination path like "knowledge-base/people"
 * or "knowledge-base/organizations/safety-orgs".
 *
 * Returns the entityType string or null if no mapping exists.
 */
export function inferEntityType(destPath: string): string | null {
  // Extract the category segment: "knowledge-base/people" → "people"
  // Also handles subcategories: "knowledge-base/organizations/safety-orgs" → "organizations"
  const segments = destPath.split('/').filter(Boolean);

  // Try from most specific to least specific
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (CATEGORY_ENTITY_TYPES[segment]) {
      return CATEGORY_ENTITY_TYPES[segment];
    }
  }

  return null;
}
