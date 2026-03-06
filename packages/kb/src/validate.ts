/**
 * Schema validation for the Knowledge Base graph.
 *
 * Checks performed:
 *
 * Existing (1–6):
 *  1. required-properties    (error)   — entity missing required property
 *  2. recommended-properties (warning) — entity missing recommended property
 *  3. property-applies-to    (warning) — property used on wrong entity type
 *  4. ref-integrity          (error)   — ref/refs point to non-existent entities
 *  5. item-collection-schema (error/warning) — item entries vs schema
 *  6. completeness           (info)    — % of required+recommended present
 *
 * New data integrity (7–11):
 *  7. stableid-format        (error)   — stableId must be 10 alphanumeric chars
 *  8. duplicate-stableid     (error)   — two entities share a stableId
 *  9. factid-format          (error)   — fact ID must match f_ + alphanumeric/underscore
 * 10. empty-name             (error)   — entity name is empty
 * 11. valid-end-before-as-of (error)   — validEnd earlier than asOf
 *
 * New temporal (12–14):
 * 12. temporal-missing-date  (warning) — temporal property fact has no asOf
 * 13. non-temporal-multiple  (warning) — non-temporal property has >1 fact
 * 14. stale-temporal         (info)    — most recent asOf is >2 years old
 *
 * New data quality (15–20):
 * 15. duplicate-facts        (warning) — same (entity, property, asOf) twice
 * 16. missing-source         (warning) — fact has no source URL
 * 17. unknown-property       (warning) — propertyId not in registry
 * 18. date-format            (warning) — asOf/validEnd bad format
 * 19. future-date            (warning) — asOf in the future
 * 20. bidirectional-redundancy (warning) — both sides of inverse stored
 *
 * New informational (21–22):
 * 21. orphan-entity          (info)    — entity has zero facts and zero items
 * 22. (dead-source is expensive / optional, not included in default run)
 */

import type { Graph } from "./graph";
import type {
  Fact,
  FactValue,
  FieldDef,
  ItemCollectionSchema,
  TypeSchema,
  ValidationResult,
} from "./types";

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Returns true if the entity has at least one fact for the given propertyId. */
function hasFact(graph: Graph, entityId: string, propertyId: string): boolean {
  return graph.getFacts(entityId, { property: propertyId }).length > 0;
}

/**
 * Very lightweight date-format check.
 * Accepts: YYYY, YYYY-MM, YYYY-MM-DD.
 */
function looksLikeDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value);
}

const STABLEID_RE = /^[A-Za-z0-9]{10}$/;
const FACTID_RE = /^f_[A-Za-z0-9_]+$/;

// ── Existing checks (1–6) ────────────────────────────────────────────────────

/** Check 1: required properties. */
function checkRequired(
  graph: Graph,
  entityId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const propertyId of schema.required) {
    if (!hasFact(graph, entityId, propertyId)) {
      results.push({
        severity: "error",
        entityId,
        propertyId,
        message: `Missing required property "${propertyId}" on entity "${entityId}" (type: ${schema.type}).`,
        rule: "required-properties",
      });
    }
  }

  return results;
}

/** Check 2: recommended properties. */
function checkRecommended(
  graph: Graph,
  entityId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const propertyId of schema.recommended) {
    if (!hasFact(graph, entityId, propertyId)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId,
        message: `Missing recommended property "${propertyId}" on entity "${entityId}" (type: ${schema.type}).`,
        rule: "recommended-properties",
      });
    }
  }

  return results;
}

/** Check 3: property appliesTo type constraint. */
function checkPropertyAppliesTo(
  graph: Graph,
  entityId: string,
  entityType: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    const property = graph.getProperty(fact.propertyId);
    if (!property) continue;
    if (!property.appliesTo || property.appliesTo.length === 0) continue;

    if (!property.appliesTo.includes(entityType)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Property "${fact.propertyId}" applies to [${property.appliesTo.join(", ")}] ` +
          `but entity "${entityId}" is of type "${entityType}".`,
        rule: "property-applies-to",
      });
    }
  }

  return results;
}

/** Check 4: ref/refs integrity — referenced entities must exist. */
function checkRefIntegrity(graph: Graph, entityId: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    const missingRefs = _findMissingRefs(graph, fact.value);

    for (const missingId of missingRefs) {
      results.push({
        severity: "error",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" references unknown entity "${missingId}" ` +
          `(property: "${fact.propertyId}").`,
        rule: "ref-integrity",
      });
    }
  }

  return results;
}

function _findMissingRefs(graph: Graph, value: FactValue): string[] {
  if (value.type === "ref") {
    return graph.getEntity(value.value) ? [] : [value.value];
  }

  if (value.type === "refs") {
    return value.value.filter((id) => !graph.getEntity(id));
  }

  return [];
}

/** Check 5: item collection schema validation. */
function checkItemCollections(
  graph: Graph,
  entityId: string,
  schema: TypeSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!schema.items) return results;

  for (const [collectionName, collectionSchema] of Object.entries(
    schema.items
  )) {
    const entries = graph.getItems(entityId, collectionName);

    for (const entry of entries) {
      const entryResults = _validateItemEntry(
        graph,
        entityId,
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

function _validateItemEntry(
  graph: Graph,
  entityId: string,
  collectionName: string,
  entryKey: string,
  fields: Record<string, unknown>,
  schema: ItemCollectionSchema
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const prefix = `Item "${collectionName}/${entryKey}" on entity "${entityId}"`;

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const value = fields[fieldName];

    if (fieldDef.required && (value === undefined || value === null)) {
      results.push({
        severity: "error",
        entityId,
        message: `${prefix}: missing required field "${fieldName}".`,
        rule: "item-collection-schema",
      });
      continue;
    }

    if (value !== undefined && value !== null) {
      const typeError = _checkFieldType(
        graph,
        fieldDef,
        value,
        fieldName,
        prefix
      );
      if (typeError) {
        results.push({
          severity: "warning",
          entityId,
          message: typeError,
          rule: "item-collection-schema",
        });
      }
    }
  }

  return results;
}

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
        return `${prefix}: field "${fieldName}" expected an entity ID string (ref), got ${typeof value}.`;
      }
      if (!graph.getEntity(value)) {
        return `${prefix}: field "${fieldName}" references unknown entity "${value}".`;
      }
      break;

    case "text":
      if (typeof value !== "string") {
        return `${prefix}: field "${fieldName}" expected string (text), got ${typeof value}.`;
      }
      break;

    default:
      break;
  }

  return null;
}

/** Check 6: completeness report. */
function checkCompleteness(
  graph: Graph,
  entityId: string,
  schema: TypeSchema
): ValidationResult[] {
  const tracked = [...schema.required, ...schema.recommended];
  if (tracked.length === 0) return [];

  const present = tracked.filter((p) => hasFact(graph, entityId, p)).length;
  const pct = Math.round((present / tracked.length) * 100);

  return [
    {
      severity: "info",
      entityId,
      message:
        `Completeness for "${entityId}" (type: ${schema.type}): ` +
        `${present}/${tracked.length} required+recommended properties present (${pct}%).`,
      rule: "completeness",
    },
  ];
}

// ── New data integrity checks (7–11) ─────────────────────────────────────────

/** Check 7: stableId format — must be exactly 10 alphanumeric chars. */
function checkStableIdFormat(entityId: string, stableId: string): ValidationResult[] {
  if (!STABLEID_RE.test(stableId)) {
    return [
      {
        severity: "error",
        entityId,
        message: `Entity "${entityId}" has invalid stableId "${stableId}" (must be 10 alphanumeric chars).`,
        rule: "stableid-format",
      },
    ];
  }
  return [];
}

/** Check 9: fact ID format — must match f_ + alphanumeric/underscore. */
function checkFactIdFormat(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    // Skip computed/derived facts (e.g. inv_ prefix from inverse computation)
    if (fact.derivedFrom) continue;
    if (!FACTID_RE.test(fact.id)) {
      results.push({
        severity: "error",
        entityId,
        message: `Fact "${fact.id}" on "${entityId}" has invalid ID format (must match f_ + alphanumeric/underscore).`,
        rule: "factid-format",
      });
    }
  }

  return results;
}

/** Check 10: empty name. */
function checkEmptyName(entityId: string, name: string): ValidationResult[] {
  if (!name || name.trim().length === 0) {
    return [
      {
        severity: "error",
        entityId,
        message: `Entity "${entityId}" has empty or missing name.`,
        rule: "empty-name",
      },
    ];
  }
  return [];
}

/** Check 11: validEnd before asOf. */
function checkValidEndBeforeAsOf(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.asOf && fact.validEnd && fact.validEnd < fact.asOf) {
      results.push({
        severity: "error",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" has validEnd "${fact.validEnd}" before asOf "${fact.asOf}".`,
        rule: "valid-end-before-as-of",
      });
    }
  }

  return results;
}

// ── New temporal checks (12–14) ──────────────────────────────────────────────

/** Check 12: temporal property fact missing asOf date. */
function checkTemporalMissingDate(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.asOf) continue;
    // Skip computed facts (from inverse computation)
    if (fact.derivedFrom) continue;

    const property = graph.getProperty(fact.propertyId);
    if (property?.temporal) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" for temporal property "${fact.propertyId}" has no asOf date.`,
        rule: "temporal-missing-date",
      });
    }
  }

  return results;
}

/** Check 13: non-temporal property has multiple facts. */
function checkNonTemporalMultiple(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  // Group by propertyId
  const byProperty = new Map<string, Fact[]>();
  for (const fact of facts) {
    const existing = byProperty.get(fact.propertyId);
    if (existing) {
      existing.push(fact);
    } else {
      byProperty.set(fact.propertyId, [fact]);
    }
  }

  for (const [propertyId, propertyFacts] of byProperty) {
    if (propertyFacts.length <= 1) continue;

    const property = graph.getProperty(propertyId);
    // Skip if property is unknown, temporal, or computed
    if (!property) continue;
    if (property.temporal) continue;
    if (property.computed) continue;

    results.push({
      severity: "warning",
      entityId,
      propertyId,
      message:
        `Non-temporal property "${propertyId}" on "${entityId}" has ${propertyFacts.length} facts (expected 1).`,
      rule: "non-temporal-multiple",
    });
  }

  return results;
}

/** Check 14: stale temporal data — most recent asOf is >2 years old. */
function checkStaleTemporal(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  // Group temporal facts by propertyId
  const byProperty = new Map<string, Fact[]>();
  for (const fact of facts) {
    const property = graph.getProperty(fact.propertyId);
    if (!property?.temporal) continue;
    if (fact.derivedFrom) continue;

    const existing = byProperty.get(fact.propertyId);
    if (existing) {
      existing.push(fact);
    } else {
      byProperty.set(fact.propertyId, [fact]);
    }
  }

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const cutoff = twoYearsAgo.toISOString().slice(0, 10);

  for (const [propertyId, propertyFacts] of byProperty) {
    // Find the most recent asOf
    const dates = propertyFacts
      .map((f) => f.asOf)
      .filter((d): d is string => d !== undefined)
      .sort();
    if (dates.length === 0) continue;

    const mostRecent = dates[dates.length - 1];
    if (mostRecent < cutoff) {
      results.push({
        severity: "info",
        entityId,
        propertyId,
        message:
          `Temporal property "${propertyId}" on "${entityId}" may be stale — most recent value is from ${mostRecent}.`,
        rule: "stale-temporal",
      });
    }
  }

  return results;
}

// ── New data quality checks (15–20) ──────────────────────────────────────────

/** Check 15: duplicate facts — same (entity, property, asOf) tuple. */
function checkDuplicateFacts(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  const seen = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.propertyId}|${fact.asOf ?? ""}`;
    if (seen.has(key)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Duplicate fact on "${entityId}": property "${fact.propertyId}" with asOf="${fact.asOf ?? "(none)"} appears multiple times.`,
        rule: "duplicate-facts",
      });
    }
    seen.add(key);
  }

  return results;
}

/** Check 16: missing source URL. */
function checkMissingSource(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.derivedFrom) continue;
    if (!fact.source) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" (property: "${fact.propertyId}") has no source URL.`,
        rule: "missing-source",
      });
    }
  }

  return results;
}

/** Check 17: unknown property — propertyId not in registry. */
function checkUnknownProperty(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.derivedFrom) continue;
    const property = graph.getProperty(fact.propertyId);
    if (!property) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" uses unknown property "${fact.propertyId}" (not in properties.yaml).`,
        rule: "unknown-property",
      });
    }
  }

  return results;
}

/** Check 18: date format — asOf and validEnd must be valid date strings. */
function checkDateFormat(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.asOf && !looksLikeDate(fact.asOf)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" has invalid asOf date "${fact.asOf}" (expected YYYY, YYYY-MM, or YYYY-MM-DD).`,
        rule: "date-format",
      });
    }
    if (fact.validEnd && !looksLikeDate(fact.validEnd)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" has invalid validEnd date "${fact.validEnd}" (expected YYYY, YYYY-MM, or YYYY-MM-DD).`,
        rule: "date-format",
      });
    }
  }

  return results;
}

/** Check 19: future date — asOf is after today. */
function checkFutureDate(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);
  const today = new Date().toISOString().slice(0, 10);

  for (const fact of facts) {
    if (fact.asOf && looksLikeDate(fact.asOf) && fact.asOf > today) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" has asOf date "${fact.asOf}" in the future.`,
        rule: "future-date",
      });
    }
  }

  return results;
}

/** Check 20: bidirectional redundancy — both sides of an inverse stored. */
function checkBidirectionalRedundancy(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.derivedFrom) continue;

    const property = graph.getProperty(fact.propertyId);
    if (!property?.inverseId) continue;

    // Check if the inverse property has a fact pointing back
    if (fact.value.type === "ref") {
      const targetId = fact.value.value;
      const inverseFacts = graph.getFacts(targetId, {
        property: property.inverseId,
      });
      // Look for a non-derived fact that points back to this entity
      const manualInverse = inverseFacts.find(
        (f) =>
          !f.derivedFrom &&
          ((f.value.type === "ref" && f.value.value === entityId) ||
            (f.value.type === "refs" && f.value.value.includes(entityId)))
      );
      if (manualInverse) {
        results.push({
          severity: "warning",
          entityId,
          propertyId: fact.propertyId,
          message:
            `Bidirectional redundancy: "${entityId}" has "${fact.propertyId}" -> "${targetId}", ` +
            `and "${targetId}" manually stores the inverse "${property.inverseId}" -> "${entityId}". ` +
            `Only one side should be stored; the inverse is computed automatically.`,
          rule: "bidirectional-redundancy",
        });
      }
    }
  }

  return results;
}

// ── New informational checks (21) ────────────────────────────────────────────

/** Check 21: orphan entity — zero facts and zero item collections. */
function checkOrphanEntity(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const facts = graph.getFacts(entityId);
  const collections = graph.getItemCollectionNames(entityId);

  if (facts.length === 0 && collections.length === 0) {
    return [
      {
        severity: "info",
        entityId,
        message: `Entity "${entityId}" has no facts and no item collections (orphan).`,
        rule: "orphan-entity",
      },
    ];
  }

  return [];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a single entity against its TypeSchema and data quality rules.
 * Returns an array of ValidationResult objects.
 */
export function validateEntity(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const entity = graph.getEntity(entityId);
  if (!entity) {
    return [
      {
        severity: "error",
        entityId,
        message: `Entity "${entityId}" not found in graph.`,
        rule: "entity-exists",
      },
    ];
  }

  // Run checks that don't require a schema
  const results: ValidationResult[] = [
    ...checkStableIdFormat(entityId, entity.stableId),
    ...checkEmptyName(entityId, entity.name),
    ...checkFactIdFormat(graph, entityId),
    ...checkValidEndBeforeAsOf(graph, entityId),
    ...checkPropertyAppliesTo(graph, entityId, entity.type),
    ...checkRefIntegrity(graph, entityId),
    ...checkTemporalMissingDate(graph, entityId),
    ...checkNonTemporalMultiple(graph, entityId),
    ...checkStaleTemporal(graph, entityId),
    ...checkDuplicateFacts(graph, entityId),
    ...checkMissingSource(graph, entityId),
    ...checkUnknownProperty(graph, entityId),
    ...checkDateFormat(graph, entityId),
    ...checkFutureDate(graph, entityId),
    ...checkBidirectionalRedundancy(graph, entityId),
    ...checkOrphanEntity(graph, entityId),
  ];

  // Schema-dependent checks
  const schema = graph.getSchema(entity.type);
  if (!schema) {
    results.push({
      severity: "warning",
      entityId,
      message: `No TypeSchema registered for type "${entity.type}" (entity: "${entityId}"). Skipping schema checks.`,
      rule: "schema-exists",
    });
    return results;
  }

  results.push(
    ...checkRequired(graph, entityId, schema),
    ...checkRecommended(graph, entityId, schema),
    ...checkItemCollections(graph, entityId, schema),
    ...checkCompleteness(graph, entityId, schema)
  );

  return results;
}

/**
 * Validates the entire graph — runs per-entity checks plus graph-wide checks.
 * Returns an array of all ValidationResult objects.
 */
export function validate(graph: Graph): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Graph-wide check: duplicate stableIds (check 8)
  const stableIdMap = new Map<string, string[]>();
  for (const entity of graph.getAllEntities()) {
    const existing = stableIdMap.get(entity.stableId);
    if (existing) {
      existing.push(entity.id);
    } else {
      stableIdMap.set(entity.stableId, [entity.id]);
    }
  }
  for (const [stableId, entityIds] of stableIdMap) {
    if (entityIds.length > 1) {
      results.push({
        severity: "error",
        message:
          `Duplicate stableId "${stableId}" shared by entities: ${entityIds.join(", ")}.`,
        rule: "duplicate-stableid",
      });
    }
  }

  // Per-entity checks
  for (const entity of graph.getAllEntities()) {
    results.push(...validateEntity(graph, entity.id));
  }

  return results;
}
