/**
 * Canonical entity type names — SINGLE SOURCE OF TRUTH.
 *
 * Every valid entityType string is listed here.
 * Other modules (entity-ontology, schema, entity-schemas) derive their
 * type lists from this file rather than hardcoding them.
 *
 * IMPORTANT: This file has NO external dependencies (no React, no Zod,
 * no npm packages) so it can be safely imported by any module, including
 * tooling that runs outside the Next.js context.
 */

// =============================================================================
// CANONICAL ENTITY TYPE NAMES
// =============================================================================

/**
 * All canonical (primary) entity type names.
 * These are the "real" types — each represents a distinct entity category.
 */
const CANONICAL_ENTITY_TYPE_NAMES = [
  "risk",
  "risk-factor",
  "capability",
  "safety-agenda",
  "approach",
  "project",
  "policy",
  "organization",
  "crux",
  "concept",
  "case-study",
  "person",
  "scenario",
  "resource",
  "funder",
  "historical",
  "analysis",
  "model",
  "parameter",
  "metric",
  "argument",
  "table",
  "diagram",
  "insight",
  "event",
  "debate",
  "intelligence-paradigm",
  "internal",
  // AI Transition Model specific types
  "ai-transition-model-parameter",
  "ai-transition-model-metric",
  "ai-transition-model-scenario",
  "ai-transition-model-factor",
  "ai-transition-model-subitem",
] as const;

/** TypeScript type for a canonical entity type name */
type CanonicalEntityTypeName = (typeof CANONICAL_ENTITY_TYPE_NAMES)[number];

// =============================================================================
// ENTITY TYPE ALIASES (old/alternate names → canonical names)
// =============================================================================

/**
 * Maps legacy and alternate type names to their canonical equivalents.
 * These exist for backward compatibility with old YAML data.
 */
export const ENTITY_TYPE_ALIASES: Record<string, CanonicalEntityTypeName> = {
  // Renamed types
  researcher: "person",
  // Lab types → organization (orgType discriminator carries the detail)
  lab: "organization",
  "lab-frontier": "organization",
  "lab-research": "organization",
  "lab-startup": "organization",
  "lab-academic": "organization",
  // Plural-form aliases found in YAML data
  "safety-approaches": "safety-agenda",
  policies: "policy",
  concepts: "concept",
  events: "event",
  models: "model",
};

/** All alias type name strings */
const ENTITY_TYPE_ALIAS_NAMES = Object.keys(ENTITY_TYPE_ALIASES) as Array<
  keyof typeof ENTITY_TYPE_ALIASES
>;

// =============================================================================
// COMBINED LIST (canonical + aliases)
// =============================================================================

/**
 * All valid entity type names: canonical types + aliases.
 * Use this for Zod enums and validation that must accept both.
 */
export const ALL_ENTITY_TYPE_NAMES = [
  ...CANONICAL_ENTITY_TYPE_NAMES,
  ...ENTITY_TYPE_ALIAS_NAMES,
] as const;

/** TypeScript type for any valid entity type name (canonical or alias) */
export type AnyEntityTypeName = (typeof ALL_ENTITY_TYPE_NAMES)[number];

// =============================================================================
// OLD TYPE REMAPPING (for build-time entity transformation)
// =============================================================================

/**
 * Maps old database.json `type` values to canonical `entityType` values.
 * Types not listed here map to themselves (identity mapping).
 *
 * Previously duplicated in entity-schemas.ts as OLD_TYPE_MAP.
 */
export const OLD_TYPE_MAP: Record<string, string> = {
  // Lab types → organization
  lab: "organization",
  "lab-frontier": "organization",
  "lab-research": "organization",
  "lab-academic": "organization",
  "lab-startup": "organization",
  // Researcher → person
  researcher: "person",
};

/**
 * Maps old lab-* types to organization orgType values.
 * Used during entity transformation to set the orgType discriminator.
 *
 * Previously duplicated in entity-schemas.ts as OLD_LAB_TYPE_TO_ORG_TYPE.
 */
export const OLD_LAB_TYPE_TO_ORG_TYPE: Record<string, string> = {
  lab: "generic",
  "lab-frontier": "frontier-lab",
  "lab-research": "safety-org",
  "lab-academic": "academic",
  "lab-startup": "startup",
};

