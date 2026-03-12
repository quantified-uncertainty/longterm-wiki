/**
 * Core data model for the Knowledge Base library.
 * Inspired by Ken Standard, extended with temporal data and stable IDs.
 */

// ── Values ──────────────────────────────────────────────────────────

export type FactValue =
  | { type: "number"; value: number; unit?: string }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "ref"; value: string }
  | { type: "refs"; value: string[] }
  | { type: "range"; low: number; high: number; unit?: string }
  | { type: "min"; value: number; unit?: string }
  | { type: "json"; value: unknown };

// ── Entity ──────────────────────────────────────────────────────────

export interface Entity {
  /** Stable 10-char random ID (primary identity, formerly stableId) */
  id: string;
  /** References a TypeSchema: "organization", "person" */
  type: string;
  /** Display name */
  name: string;
  /** Parent entity ID (e.g., funding round → org) */
  parent?: string;
  /** Alternative names for search */
  aliases?: string[];
  /** Former IDs for redirects */
  previousIds?: string[];
  /** Wiki page URL ID with E prefix, e.g. "E22" (formerly numericId) */
  wikiPageId?: string;
  /** @deprecated Use `id` instead. Alias kept for backward compat during migration. */
  stableId: string;
  /** @deprecated Use `wikiPageId` instead. Alias kept for backward compat during migration. */
  numericId?: string;
}

// ── Fact ────────────────────────────────────────────────────────────

export interface Fact {
  /** Fact ID: 10-char alphanumeric, or legacy "f_" + 10-char, or "inv_" for derived */
  id: string;
  /** Entity ID (stable 10-char ID) this fact is about */
  subjectId: string;
  /** Property ID from the registry */
  propertyId: string;
  /** Typed value */
  value: FactValue;
  /** When this was true (ISO date or YYYY-MM) */
  asOf?: string;
  /** When this stopped being true (null/undefined = still true) */
  validEnd?: string;
  /** Source URL */
  source?: string;
  /** Relevant excerpt from source */
  sourceQuote?: string;
  /** Free-text annotation */
  notes?: string;
  /** If this fact was computed (e.g., inverse relationship) */
  derivedFrom?: string;
  /** ISO 4217 currency override (e.g., "GBP"). If absent, property.unit applies. */
  currency?: string;
  /** Approximate USD value for cross-currency comparison */
  usdEquivalent?: number;
  /** Exchange rate used for conversion (e.g., 1.25 for £1 = $1.25) */
  exchangeRate?: number;
  /** When the exchange rate was observed (YYYY-MM or YYYY-MM-DD) */
  exchangeRateDate?: string;
  /** Dollar year for inflation context (e.g., 2024). Reserved for future use. */
  dollarYear?: number;
}

// ── Property ────────────────────────────────────────────────────────

export interface PropertyDisplay {
  divisor?: number;
  prefix?: string;
  suffix?: string;
}

export interface Property {
  /** Property ID: "revenue", "employed-by" */
  id: string;
  /** Display name: "Revenue", "Employed By" */
  name: string;
  description?: string;
  /** Value type: "number", "text", "date", "ref", "refs", "boolean" */
  dataType: string;
  /** Unit: "USD", "percent", "tokens" */
  unit?: string;
  /** Grouping: "financial", "people", "safety" */
  category?: string;
  /** Inverse property ID: "employed-by" → "employer-of" */
  inverseId?: string;
  /** Inverse display name: "Employed By" → "Employs" */
  inverseName?: string;
  /** Entity types this property is valid for */
  appliesTo?: string[];
  /** Display formatting */
  display?: PropertyDisplay;
  /** If true, this property is computed (never stored directly) */
  computed?: boolean;
  /** If true, values change over time (revenue, headcount). asOf = "measured at". */
  temporal?: boolean;
}

// ── Type Schemas ────────────────────────────────────────────────────

export interface FieldDef {
  type: string;
  required?: boolean;
  unit?: string;
  description?: string;
}

export interface TypeSchema {
  /** Entity type this schema applies to: "organization", "person" */
  type: string;
  /** Display name: "Organization" */
  name: string;
  /** Property IDs that must have facts */
  required: string[];
  /** Property IDs that should have facts */
  recommended: string[];
}

// ── YAML file shapes ────────────────────────────────────────────────

/**
 * Shape of an entity's YAML file (data/things/anthropic.yaml).
 * Supports both old format (id=slug, stableId) and new format (id=stableId, slug).
 */
export interface EntityFile {
  thing: {
    /** Old format: slug. New format: stable 10-char ID. */
    id: string;
    /** Old format only: stable 10-char ID. Absent in new format. */
    stableId?: string;
    /** New format only: human-readable slug. Absent in old format. */
    slug?: string;
    type: string;
    name: string;
    parent?: string;
    aliases?: string[];
    previousIds?: string[];
    /** Old format: wiki page ID. */
    numericId?: string;
    /** New format: wiki page ID. */
    wikiPageId?: string;
  };
  facts?: RawFact[];
  /** File-level source aliases for !src tags. Maps alias → URL. */
  _sources?: Record<string, string>;
}

/** Fact as stored in YAML (before normalization).
 * Note: asOf/validEnd are typed as `unknown` because YAML custom tags
 * (e.g., `!date 2025-11`) produce DateMarker objects, not strings.
 * The loader's parseFact() normalizes these to strings. */
export interface RawFact {
  id: string;
  property: string;
  value: unknown;
  asOf?: unknown;
  validEnd?: unknown;
  source?: string;
  sourceQuote?: string;
  notes?: string;
  /** ISO 4217 currency override (e.g., "GBP") */
  currency?: string;
  /** Approximate USD value for cross-currency comparison */
  usdEquivalent?: number;
  /** Exchange rate used for conversion */
  exchangeRate?: number;
  /** When the exchange rate was observed */
  exchangeRateDate?: string;
  /** Dollar year for inflation context (reserved for future use) */
  dollarYear?: number;
}

/** Shape of properties.yaml */
export interface PropertiesFile {
  properties: Record<string, Omit<Property, "id">>;
}

/** Shape of a schema YAML file */
export interface SchemaFile {
  type: string;
  name: string;
  required: string[];
  recommended: string[];
}

// ── Validation ──────────────────────────────────────────────────────

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationResult {
  severity: ValidationSeverity;
  entityId?: string;
  propertyId?: string;
  message: string;
  /** Which check produced this */
  rule: string;
}

// ── Query options ───────────────────────────────────────────────────

export interface FactQuery {
  property?: string;
  /** Only return facts that are currently valid (no validEnd) */
  current?: boolean;
}

export interface PropertyQuery {
  /** Only return the latest fact per entity (by asOf) */
  latest?: boolean;
}
