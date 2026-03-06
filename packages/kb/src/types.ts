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
  | { type: "json"; value: unknown };

// ── Entity ──────────────────────────────────────────────────────────

export interface Entity {
  /** Human-readable slug: "anthropic", "claude-3-5-sonnet" */
  id: string;
  /** Random 10-char ID that survives renames */
  stableId: string;
  /** References a TypeSchema: "organization", "person" */
  type: string;
  /** Display name */
  name: string;
  /** Parent entity ID (e.g., funding round → org) */
  parent?: string;
  /** Alternative names for search */
  aliases?: string[];
  /** Former slugs for redirects */
  previousIds?: string[];
  /** Legacy wiki URL ID (E42) */
  numericId?: number;
}

// ── Fact ────────────────────────────────────────────────────────────

export interface Fact {
  /** Random 10-char "f_xxxxxxxx" or content-hash */
  id: string;
  /** Entity ID (slug) this fact is about */
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
}

// ── Type Schemas ────────────────────────────────────────────────────

export interface FieldDef {
  type: string;
  required?: boolean;
  unit?: string;
  description?: string;
}

export interface ItemCollectionSchema {
  description: string;
  fields: Record<string, FieldDef>;
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
  /** Named item collections (e.g., funding-rounds, key-people) */
  items?: Record<string, ItemCollectionSchema>;
}

// ── Items (lightweight sub-collections) ─────────────────────────────

export interface ItemEntry {
  /** Local key within the collection: "series-a", "dario-ceo" */
  key: string;
  /** Typed fields (schema defined in ItemCollectionSchema) */
  fields: Record<string, unknown>;
}

export interface ItemCollection {
  /** References an item type (used for schema lookup) */
  type: string;
  /** Keyed entries */
  entries: Record<string, Record<string, unknown>>;
}

// ── YAML file shapes ────────────────────────────────────────────────

/** Shape of an entity's YAML file (data/things/anthropic.yaml) */
export interface EntityFile {
  thing: {
    id: string;
    stableId: string;
    type: string;
    name: string;
    parent?: string;
    aliases?: string[];
    previousIds?: string[];
    numericId?: number;
  };
  facts?: RawFact[];
  items?: Record<string, RawItemCollection>;
}

/** Fact as stored in YAML (before normalization) */
export interface RawFact {
  id: string;
  property: string;
  value: unknown;
  asOf?: string;
  validEnd?: string;
  source?: string;
  sourceQuote?: string;
  notes?: string;
}

/** Item collection as stored in YAML */
export interface RawItemCollection {
  type: string;
  entries: Record<string, Record<string, unknown>>;
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
  items?: Record<string, {
    description: string;
    fields: Record<string, FieldDef>;
  }>;
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
