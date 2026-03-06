/**
 * Schema validation for the Knowledge Base graph.
 *
 * Checks performed:
 *  1. required-properties  (error)   — each thing must have a fact for every
 *                                      property listed in its TypeSchema.required
 *  2. recommended-properties (warning) — same check for TypeSchema.recommended
 *  3. property-applies-to  (warning)  — if a property lists appliesTo, ensure
 *                                       the thing's type is in that list
 *  4. ref-integrity        (error)    — ref/refs values must point to existing
 *                                       things in the graph
 *  5. item-collection-schema (error/warning) — validate item entries against
 *                                       the ItemCollectionSchema defined in the
 *                                       thing's TypeSchema (if one exists)
 *  6. completeness         (info)     — percentage of required+recommended
 *                                       properties that have at least one fact
 */

import type { Graph } from "./graph.ts";
import type {
  Fact,
  FactValue,
  FieldDef,
  ItemCollectionSchema,
  TypeSchema,
  ValidationResult,
} from "./types.ts";

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Returns true if the thing has at least one fact for the given propertyId. */
function hasFact(graph: Graph, thingId: string, propertyId: string): boolean {
  return graph.getFacts(thingId, { property: propertyId }).length > 0;
}

/**
 * Very lightweight date-format check.
 * Accepts: YYYY, YYYY-MM, YYYY-MM-DD.
 */
function looksLikeDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value);
}

// ── Per-thing check implementations ───────────────────────────────────────────

/** Check 1: required properties. */
function checkRequired(
  graph: Graph,
  thingId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const propertyId of schema.required) {
    if (!hasFact(graph, thingId, propertyId)) {
      results.push({
        severity: "error",
        thingId,
        propertyId,
        message: `Missing required property "${propertyId}" on thing "${thingId}" (type: ${schema.type}).`,
        rule: "required-properties",
      });
    }
  }

  return results;
}

/** Check 2: recommended properties. */
function checkRecommended(
  graph: Graph,
  thingId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const propertyId of schema.recommended) {
    if (!hasFact(graph, thingId, propertyId)) {
      results.push({
        severity: "warning",
        thingId,
        propertyId,
        message: `Missing recommended property "${propertyId}" on thing "${thingId}" (type: ${schema.type}).`,
        rule: "recommended-properties",
      });
    }
  }

  return results;
}

/** Check 3: property appliesTo type constraint. */
function checkPropertyAppliesTo(
  graph: Graph,
  thingId: string,
  thingType: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(thingId);

  for (const fact of facts) {
    const property = graph.getProperty(fact.propertyId);
    if (!property) continue; // Unknown properties are caught by other checks if needed.
    if (!property.appliesTo || property.appliesTo.length === 0) continue;

    if (!property.appliesTo.includes(thingType)) {
      results.push({
        severity: "warning",
        thingId,
        propertyId: fact.propertyId,
        message:
          `Property "${fact.propertyId}" applies to [${property.appliesTo.join(", ")}] ` +
          `but thing "${thingId}" is of type "${thingType}".`,
        rule: "property-applies-to",
      });
    }
  }

  return results;
}

/** Check 4: ref/refs integrity — referenced things must exist. */
function checkRefIntegrity(graph: Graph, thingId: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(thingId);

  for (const fact of facts) {
    const missingRefs = _findMissingRefs(graph, fact.value);

    for (const missingId of missingRefs) {
      results.push({
        severity: "error",
        thingId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${thingId}" references unknown thing "${missingId}" ` +
          `(property: "${fact.propertyId}").`,
        rule: "ref-integrity",
      });
    }
  }

  return results;
}

/**
 * Returns the list of referenced thing IDs that do not exist in the graph.
 * Only inspects ref/refs value types.
 */
function _findMissingRefs(graph: Graph, value: FactValue): string[] {
  if (value.type === "ref") {
    return graph.getThing(value.value) ? [] : [value.value];
  }

  if (value.type === "refs") {
    return value.value.filter((id) => !graph.getThing(id));
  }

  return [];
}

/** Check 5: item collection schema validation. */
function checkItemCollections(
  graph: Graph,
  thingId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!schema.items) return results;

  for (const [collectionName, collectionSchema] of Object.entries(
    schema.items
  )) {
    const entries = graph.getItems(thingId, collectionName);

    for (const entry of entries) {
      const entryResults = _validateItemEntry(
        graph,
        thingId,
        collectionName,
        entry.key,
        entry.fields,
        collectionSchema
      );
      results.push(...entryResults);
    }
  }

  return results;
}

/**
 * Validates a single item entry against an ItemCollectionSchema.
 * Produces errors for missing required fields and warnings for type mismatches.
 */
function _validateItemEntry(
  graph: Graph,
  thingId: string,
  collectionName: string,
  entryKey: string,
  fields: Record<string, unknown>,
  schema: ItemCollectionSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const prefix = `Item "${collectionName}/${entryKey}" on thing "${thingId}"`;

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const value = fields[fieldName];

    // Required field presence check (error).
    if (fieldDef.required && (value === undefined || value === null)) {
      results.push({
        severity: "error",
        thingId,
        message: `${prefix}: missing required field "${fieldName}".`,
        rule: "item-collection-schema",
      });
      continue; // Skip type check for absent field.
    }

    // Type validity check (warning) — only when value is present.
    if (value !== undefined && value !== null) {
      const typeError = _checkFieldType(graph, fieldDef, value, fieldName, prefix);
      if (typeError) {
        results.push({
          severity: "warning",
          thingId,
          message: typeError,
          rule: "item-collection-schema",
        });
      }
    }
  }

  return results;
}

/**
 * Returns an error message string if `value` does not match the expected type
 * from `fieldDef`, or null if the value is acceptable.
 */
function _checkFieldType(
  graph: Graph,
  fieldDef: FieldDef,
  value: unknown,
  fieldName: string,
  prefix: string
): string | null {
  switch (fieldDef.type) {
    case "number":
      if (typeof value !== "number") {
        return `${prefix}: field "${fieldName}" expected number, got ${typeof value}.`;
      }
      break;

    case "boolean":
      if (typeof value !== "boolean") {
        return `${prefix}: field "${fieldName}" expected boolean, got ${typeof value}.`;
      }
      break;

    case "date":
      if (!looksLikeDate(value)) {
        return (
          `${prefix}: field "${fieldName}" expected a date string (YYYY, YYYY-MM, ` +
          `or YYYY-MM-DD), got ${JSON.stringify(value)}.`
        );
      }
      break;

    case "ref":
      if (typeof value !== "string") {
        return `${prefix}: field "${fieldName}" expected a thing ID string (ref), got ${typeof value}.`;
      }
      // Verify the referenced thing exists.
      if (!graph.getThing(value)) {
        return (
          `${prefix}: field "${fieldName}" references unknown thing "${value}".`
        );
      }
      break;

    case "text":
      if (typeof value !== "string") {
        return `${prefix}: field "${fieldName}" expected string (text), got ${typeof value}.`;
      }
      break;

    // "json" and unknown types: no type check.
    default:
      break;
  }

  return null;
}

/** Check 6: completeness report. */
function checkCompleteness(
  graph: Graph,
  thingId: string,
  schema: TypeSchema
): ValidationResult[] {
  const tracked = [...schema.required, ...schema.recommended];
  if (tracked.length === 0) return [];

  const present = tracked.filter((p) => hasFact(graph, thingId, p)).length;
  const pct = Math.round((present / tracked.length) * 100);

  return [
    {
      severity: "info",
      thingId,
      message:
        `Completeness for "${thingId}" (type: ${schema.type}): ` +
        `${present}/${tracked.length} required+recommended properties present (${pct}%).`,
      rule: "completeness",
    },
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a single thing against its TypeSchema.
 * Returns an array of ValidationResult objects.
 *
 * If no TypeSchema is registered for the thing's type, a warning is returned
 * and no further checks are run for that thing.
 */
export function validateThing(
  graph: Graph,
  thingId: string
): ValidationResult[] {
  const thing = graph.getThing(thingId);
  if (!thing) {
    return [
      {
        severity: "error",
        thingId,
        message: `Thing "${thingId}" not found in graph.`,
        rule: "thing-exists",
      },
    ];
  }

  const schema = graph.getSchema(thing.type);
  if (!schema) {
    return [
      {
        severity: "warning",
        thingId,
        message: `No TypeSchema registered for type "${thing.type}" (thing: "${thingId}"). Skipping schema checks.`,
        rule: "schema-exists",
      },
    ];
  }

  return [
    ...checkRequired(graph, thingId, schema),
    ...checkRecommended(graph, thingId, schema),
    ...checkPropertyAppliesTo(graph, thingId, thing.type),
    ...checkRefIntegrity(graph, thingId),
    ...checkItemCollections(graph, thingId, schema),
    ...checkCompleteness(graph, thingId, schema),
  ];
}

/**
 * Validates the entire graph — runs validateThing() on every thing.
 * Returns an array of all ValidationResult objects across all things.
 */
export function validate(graph: Graph): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const thing of graph.getAllThings()) {
    results.push(...validateThing(graph, thing.id));
  }

  return results;
}
