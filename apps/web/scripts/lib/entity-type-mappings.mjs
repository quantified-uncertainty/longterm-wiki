/**
 * Entity Type Mappings (Plain JS)
 *
 * Canonical source for old-to-new entity type mappings, shared between:
 * - app/scripts/lib/entity-transform.mjs (build-time)
 * - app/src/data/entity-type-names.ts (TypeScript re-exports these same values)
 *
 * If you update mappings here, update entity-type-names.ts to match.
 */

/** Maps old database.json `type` values to canonical `entityType` values. */
export const OLD_TYPE_MAP = {
  lab: 'organization',
  'lab-frontier': 'organization',
  'lab-research': 'organization',
  'lab-academic': 'organization',
  'lab-startup': 'organization',
  researcher: 'person',
};

/** Maps old lab-* types to organization orgType values. */
export const OLD_LAB_TYPE_TO_ORG_TYPE = {
  lab: 'generic',
  'lab-frontier': 'frontier-lab',
  'lab-research': 'safety-org',
  'lab-academic': 'academic',
  'lab-startup': 'startup',
};
