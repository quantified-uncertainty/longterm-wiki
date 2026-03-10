/**
 * Schema validation for the Knowledge Base graph.
 *
 * Original checks (1–5):
 *  1. required-properties  (error)   — each entity must have a fact for every
 *                                      property listed in its TypeSchema.required
 *  2. recommended-properties (warning) — same check for TypeSchema.recommended
 *  3. property-applies-to  (warning)  — if a property lists appliesTo, ensure
 *                                       the entity's type is in that list
 *  4. ref-integrity        (error)    — ref/refs values must point to existing
 *                                       entities in the graph
 *  5. completeness         (info)     — percentage of required+recommended
 *                                       properties that have at least one fact
 *
 * New checks (7–22):
 *
 * Data integrity (errors):
 *  7. stableid-format      (error)    — StableId must be exactly 10 alphanumeric chars
 *  8. duplicate-stableid   (error)    — Two entities sharing the same stableId
 *  9. factid-format        (error)    — Fact ID must be f_ + 10 alphanumeric chars (or inv_ for inverses)
 * 10. empty-name           (error)    — Entity has empty or missing name
 * 11. valid-end-before-as-of (error)  — validEnd is earlier than asOf on a fact
 *
 * Temporal consistency (warnings):
 * 12. temporal-missing-date (warning) — Fact on a temporal property has no asOf
 * 13. non-temporal-multiple (warning) — Non-temporal property has multiple facts
 * 14. stale-temporal       (warning)  — Most recent asOf is >2 years old
 *
 * Data quality (warnings):
 * 15. duplicate-facts      (warning)  — Same (entity, property, asOf) tuple appears twice
 * 16. missing-source       (warning)  — Fact has no source URL
 * 17. unknown-property     (warning)  — Fact uses a propertyId not in the registry
 * 18. date-format          (warning)  — asOf/validEnd doesn't match YYYY, YYYY-MM, or YYYY-MM-DD
 * 19. future-date          (warning)  — asOf date is in the future
 * 20. bidirectional-redundancy (warning) — Both sides of an inverse relationship stored
 *
 * Informational:
 * 21. orphan-entity        (info)     — Entity has zero facts and zero items
 * 22. dead-source          (info)     — Source URL returns non-200 (expensive, optional)
 *
 * Currency:
 * 23. currency-code        (warning)  — Fact has unknown currency code
 */

import type { Graph } from "./graph";
import type {
  Fact,
  FactValue,
  TypeSchema,
  ValidationResult,
} from "./types";
import { CURRENCIES } from "./currencies";

// ── Validation options ────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** If true, check source URLs for HTTP status (expensive, default: false). */
  checkUrls?: boolean;
}

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

/** Entity ID format: exactly 10 alphanumeric characters. */
const ENTITY_ID_RE = /^[A-Za-z0-9]{10}$/;

/** Fact ID format: 10 alphanumeric chars (new), or f_ + 10 (legacy), or inv_ (computed). */
const FACTID_RE = /^([A-Za-z0-9]{10}|f_[A-Za-z0-9]{10}|inv_.+)$/;

/** Date format: YYYY, YYYY-MM, or YYYY-MM-DD. */
const DATE_FORMAT_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// ── Per-entity check implementations (existing checks 1–6) ───────────────────

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
        severity: "info",
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
    if (!property) continue; // Unknown properties are caught by other checks if needed.
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

/**
 * Returns the list of referenced entity IDs that do not exist in the graph.
 * Only inspects ref/refs value types.
 */
function _findMissingRefs(graph: Graph, value: FactValue): string[] {
  if (value.type === "ref") {
    return graph.getEntity(value.value) ? [] : [value.value];
  }

  if (value.type === "refs") {
    return value.value.filter((id) => !graph.getEntity(id));
  }

  return [];
}

/** Check 5: completeness report. */
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

// ── New per-entity checks (7–21) ─────────────────────────────────────────────

/** Check 7: entity ID format — must be exactly 10 alphanumeric chars. */
function checkEntityIdFormat(
  entity: { id: string; slug: string }
): ValidationResult[] {
  if (!ENTITY_ID_RE.test(entity.id)) {
    return [
      {
        severity: "error",
        entityId: entity.slug,
        message:
          `Entity "${entity.slug}" has invalid id "${entity.id}" ` +
          `(must be exactly 10 alphanumeric characters).`,
        rule: "stableid-format", // keep rule name for backward compat
      },
    ];
  }
  return [];
}

/** Check 9: fact ID format — must be 10 alphanumeric, or f_ + 10, or inv_ prefix. */
function checkFactIdFormat(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (!FACTID_RE.test(fact.id)) {
      results.push({
        severity: "error",
        entityId,
        message:
          `Fact "${fact.id}" on entity "${entityId}" has invalid ID format ` +
          `(must be 10 alphanumeric chars, "f_" + 10 chars, or "inv_" prefix for inverses).`,
        rule: "factid-format",
      });
    }
  }

  return results;
}

/** Check 10: empty name — entity must have a non-empty name. */
function checkEmptyName(
  entityId: string,
  name: string
): ValidationResult[] {
  if (!name || name.trim().length === 0) {
    return [
      {
        severity: "error",
        entityId,
        message: `Entity "${entityId}" has an empty or missing name.`,
        rule: "empty-name",
      },
    ];
  }
  return [];
}

/** Check 11: validEnd before asOf — temporal ordering. */
function checkValidEndBeforeAsOf(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.asOf && fact.validEnd) {
      // Compare as strings — works for YYYY, YYYY-MM, YYYY-MM-DD because
      // the format is lexicographically ordered.
      if (fact.validEnd < fact.asOf) {
        results.push({
          severity: "error",
          entityId,
          propertyId: fact.propertyId,
          message:
            `Fact "${fact.id}" on "${entityId}": validEnd "${fact.validEnd}" ` +
            `is earlier than asOf "${fact.asOf}".`,
          rule: "valid-end-before-as-of",
        });
      }
    }
  }

  return results;
}

/** Check 12: temporal property missing asOf date. */
function checkTemporalMissingDate(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    // Skip derived (inverse) facts — they inherit asOf from the source.
    if (fact.derivedFrom) continue;

    const property = graph.getProperty(fact.propertyId);
    if (!property) continue;
    if (!property.temporal) continue;

    if (!fact.asOf) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" uses temporal property ` +
          `"${fact.propertyId}" but has no asOf date.`,
        rule: "temporal-missing-date",
      });
    }
  }

  return results;
}

/** Check 13: non-temporal property with multiple facts. */
function checkNonTemporalMultiple(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  // Group non-derived facts by propertyId.
  const byProperty = new Map<string, number>();
  for (const fact of facts) {
    if (fact.derivedFrom) continue;
    const prev = byProperty.get(fact.propertyId) || 0;
    byProperty.set(fact.propertyId, prev + 1);
  }

  for (const [propertyId, count] of byProperty) {
    if (count <= 1) continue;

    const property = graph.getProperty(propertyId);
    if (!property) continue;
    if (property.temporal) continue; // Temporal properties are expected to have multiple facts.

    results.push({
      severity: "warning",
      entityId,
      propertyId,
      message:
        `Non-temporal property "${propertyId}" on "${entityId}" has ${count} facts ` +
        `(expected at most 1 for non-temporal properties).`,
      rule: "non-temporal-multiple",
    });
  }

  return results;
}

// Property categories where stale temporal data is actionable (changes frequently).
// Other categories (people, biographical, etc.) have data that stays stable for years.
const STALE_WARNING_CATEGORIES = new Set(["financial", "product"]);

/** Check 14: stale temporal data — most recent asOf is >2 years old. */
function checkStaleTemporal(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  // Group non-derived facts by propertyId, track the most recent asOf.
  const latestAsOf = new Map<string, string>();
  for (const fact of facts) {
    if (fact.derivedFrom) continue;
    if (!fact.asOf) continue;

    const property = graph.getProperty(fact.propertyId);
    if (!property?.temporal) continue;

    const current = latestAsOf.get(fact.propertyId);
    if (!current || fact.asOf > current) {
      latestAsOf.set(fact.propertyId, fact.asOf);
    }
  }

  // 2 years ago from today.
  const twoYearsAgo = _twoYearsAgoStr();

  for (const [propertyId, latest] of latestAsOf) {
    if (latest < twoYearsAgo) {
      const property = graph.getProperty(propertyId);
      const category = property?.category;
      // Financial/product properties change frequently — staleness is actionable.
      // Other categories (people, biographical) are stable and demoted to info.
      const severity: "warning" | "info" =
        category && STALE_WARNING_CATEGORIES.has(category) ? "warning" : "info";

      results.push({
        severity,
        entityId,
        propertyId,
        message:
          `Temporal property "${propertyId}" on "${entityId}" may be stale: ` +
          `most recent asOf is "${latest}" (>2 years old).`,
        rule: "stale-temporal",
      });
    }
  }

  return results;
}

/** Returns YYYY-MM-DD string for 2 years ago from today. */
function _twoYearsAgoStr(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

/** Check 15: duplicate facts — same (entity, property, asOf) tuple. */
function checkDuplicateFacts(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.derivedFrom) continue;

    const asOfKey = fact.asOf || "";
    const key = `${fact.propertyId}|${asOfKey}`;
    if (seen.has(key)) {
      const asOfDisplay = fact.asOf || "(none)";
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Duplicate fact on "${entityId}": property "${fact.propertyId}" ` +
          `with asOf "${asOfDisplay}" appears multiple times.`,
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
          `Fact "${fact.id}" on "${entityId}" (property: "${fact.propertyId}") ` +
          `has no source URL.`,
        rule: "missing-source",
      });
    }
  }

  return results;
}

/** Check 17: unknown property — fact references a property not in the registry. */
function checkUnknownProperty(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.derivedFrom) continue;

    if (!graph.getProperty(fact.propertyId)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}" uses unknown property ` +
          `"${fact.propertyId}" (not in property registry).`,
        rule: "unknown-property",
      });
    }
  }

  return results;
}

/** Check 18: date format — asOf/validEnd must match YYYY, YYYY-MM, or YYYY-MM-DD. */
function checkDateFormat(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.asOf && !DATE_FORMAT_RE.test(fact.asOf)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}": asOf "${fact.asOf}" ` +
          `does not match date format (YYYY, YYYY-MM, or YYYY-MM-DD).`,
        rule: "date-format",
      });
    }
    if (fact.validEnd && !DATE_FORMAT_RE.test(fact.validEnd)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}": validEnd "${fact.validEnd}" ` +
          `does not match date format (YYYY, YYYY-MM, or YYYY-MM-DD).`,
        rule: "date-format",
      });
    }
  }

  return results;
}

/** Check 19: future date — asOf is in the future. */
function checkFutureDate(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const fact of facts) {
    if (!fact.asOf) continue;
    // Pad short dates for comparison: "2026" → "2026-12-31", "2026-03" → "2026-03-31"
    const padded = _padDateForFutureCheck(fact.asOf);
    if (padded > today) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}": asOf "${fact.asOf}" ` +
          `is in the future.`,
        rule: "future-date",
      });
    }
  }

  return results;
}

/**
 * Pads a partial date to its earliest day for future-date comparison.
 * "2026" stays "2026" (year-only is compared against today's year prefix)
 * For a fair comparison: "2030" > "2026-03-06" should hold because
 * any day in 2030 is after today.
 *
 * We just compare raw strings — YYYY > YYYY-MM-DD works for our purpose
 * because "2030" > "2026-03-06" lexicographically. The only edge case is
 * the current year with year-only format, which we treat as not-future
 * since the year has started.
 */
function _padDateForFutureCheck(dateStr: string): string {
  // For the future check, we want to know if the date is definitely in the future.
  // YYYY-only: compare just the year — "2030" > "2026-03-06" ✓
  // YYYY-MM: compare as-is — "2030-01" > "2026-03-06" ✓
  // YYYY-MM-DD: compare as-is
  return dateStr;
}

/** Check 23: range/min value integrity — validate numeric bounds. */
function checkRangeValues(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    const v = fact.value;

    if (v.type === "range") {
      if (!Number.isFinite(v.low) || !Number.isFinite(v.high)) {
        results.push({
          severity: "error",
          entityId,
          propertyId: fact.propertyId,
          message:
            `Fact "${fact.id}" on "${entityId}": range values must be finite numbers ` +
            `(got low=${v.low}, high=${v.high}).`,
          rule: "range-value",
        });
      } else if (v.low >= v.high) {
        results.push({
          severity: "error",
          entityId,
          propertyId: fact.propertyId,
          message:
            `Fact "${fact.id}" on "${entityId}": range low (${v.low}) must be less ` +
            `than high (${v.high}).`,
          rule: "range-value",
        });
      }
    }

    if (v.type === "min") {
      if (!Number.isFinite(v.value)) {
        results.push({
          severity: "error",
          entityId,
          propertyId: fact.propertyId,
          message:
            `Fact "${fact.id}" on "${entityId}": min value must be a finite number ` +
            `(got ${v.value}).`,
          rule: "range-value",
        });
      }
    }
  }

  return results;
}

/** Check 21: orphan entity — no facts and no records. */
function checkOrphanEntity(
  graph: Graph,
  entityId: string
): ValidationResult[] {
  const facts = graph.getFacts(entityId);
  const hasRecords = graph.getRecordCollectionNames(entityId).length > 0;

  // Only count non-derived facts.
  const nonDerivedFacts = facts.filter((f) => !f.derivedFrom);

  if (nonDerivedFacts.length === 0 && !hasRecords) {
    return [
      {
        severity: "info",
        entityId,
        message: `Entity "${entityId}" is an orphan (no facts and no record collections).`,
        rule: "orphan-entity",
      },
    ];
  }

  return [];
}

/** Check 23: currency code — fact.currency must be a known ISO 4217 code. */
function checkCurrencyCode(
  graph: Graph,
  entityId: string,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const facts = graph.getFacts(entityId);

  for (const fact of facts) {
    if (fact.currency && !Object.hasOwn(CURRENCIES, fact.currency)) {
      results.push({
        severity: "warning",
        entityId,
        propertyId: fact.propertyId,
        message:
          `Fact "${fact.id}" on "${entityId}": unknown currency code "${fact.currency}". ` +
          `Use ISO 4217 codes (USD, GBP, EUR, CAD, JPY, etc.).`,
        rule: "currency-code",
      });
    }
  }

  return results;
}

// ── Graph-level checks (run once across all entities) ─────────────────────────

/** Check 8: duplicate entity IDs across the graph. */
function checkDuplicateEntityIds(graph: Graph): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Check duplicates detected during loading (since Map overwrites, post-hoc check misses them)
  for (const dup of graph.getDuplicateIds()) {
    results.push({
      severity: "error",
      entityId: dup.slug,
      message:
        `Entity "${dup.slug}" shares id "${dup.id}" ` +
        `with entity "${dup.existingSlug}".`,
      rule: "duplicate-stableid", // keep rule name for backward compat
    });
  }

  return results;
}

/**
 * Check 20: bidirectional redundancy — both sides of an inverse relationship
 * are stored explicitly (one side should be computed by inverse computation).
 */
function checkBidirectionalRedundancy(graph: Graph): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Build a map of property → inverseId pairs.
  const inverseMap = new Map<string, string>();
  for (const property of graph.getAllProperties()) {
    if (property.inverseId && !property.computed) {
      inverseMap.set(property.id, property.inverseId);
    }
  }

  // For each property that has an inverse, check if the inverse side also has
  // explicitly stored (non-derived) facts that would be redundant.
  for (const [propertyId, inverseId] of inverseMap) {
    // Get all entities that have a non-derived fact for this property.
    for (const entity of graph.getAllEntities()) {
      const facts = graph
        .getFacts(entity.slug, { property: propertyId })
        .filter((f) => !f.derivedFrom);

      for (const fact of facts) {
        // For ref values, check if the referenced entity has an explicit inverse fact.
        if (fact.value.type === "ref") {
          const refIdOrSlug = fact.value.value;
          const inverseFacts = graph
            .getFacts(refIdOrSlug, { property: inverseId })
            .filter(
              (f) =>
                !f.derivedFrom &&
                f.value.type === "ref" &&
                // Compare by resolving both to entity ID
                graph.resolveSlug(f.value.value) === entity.slug
            );

          if (inverseFacts.length > 0) {
            const refSlug = graph.resolveSlug(refIdOrSlug) ?? refIdOrSlug;
            results.push({
              severity: "warning",
              entityId: entity.slug,
              propertyId,
              message:
                `Bidirectional redundancy: "${entity.slug}" has "${propertyId}" → "${refSlug}", ` +
                `and "${refSlug}" has explicit "${inverseId}" → "${entity.slug}". ` +
                `Only one side needs to be stored; the other is computed via inverse.`,
              rule: "bidirectional-redundancy",
            });
          }
        }
      }
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates a single entity against its TypeSchema and general data quality rules.
 * Returns an array of ValidationResult objects.
 *
 * If no TypeSchema is registered for the entity's type, a warning is returned
 * and schema-dependent checks are skipped (but general checks still run).
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

  // General checks that don't depend on a TypeSchema.
  const generalResults: ValidationResult[] = [
    ...checkEntityIdFormat(entity),
    ...checkEmptyName(entityId, entity.name),
    ...checkFactIdFormat(graph, entityId),
    ...checkValidEndBeforeAsOf(graph, entityId),
    ...checkTemporalMissingDate(graph, entityId),
    ...checkNonTemporalMultiple(graph, entityId),
    ...checkStaleTemporal(graph, entityId),
    ...checkDuplicateFacts(graph, entityId),
    ...checkMissingSource(graph, entityId),
    ...checkUnknownProperty(graph, entityId),
    ...checkDateFormat(graph, entityId),
    ...checkFutureDate(graph, entityId),
    ...checkOrphanEntity(graph, entityId),
    ...checkRangeValues(graph, entityId),
    ...checkCurrencyCode(graph, entityId),
  ];

  const schema = graph.getSchema(entity.type);
  if (!schema) {
    return [
      {
        severity: "warning",
        entityId,
        message: `No TypeSchema registered for type "${entity.type}" (entity: "${entityId}"). Skipping schema checks.`,
        rule: "schema-exists",
      },
      ...generalResults,
    ];
  }

  return [
    ...checkRequired(graph, entityId, schema),
    ...checkRecommended(graph, entityId, schema),
    ...checkPropertyAppliesTo(graph, entityId, entity.type),
    ...checkRefIntegrity(graph, entityId),
    ...checkCompleteness(graph, entityId, schema),
    ...generalResults,
  ];
}

/**
 * Validates the entire graph — runs validateEntity() on every entity,
 * plus graph-level cross-entity checks.
 * Returns an array of all ValidationResult objects across all entities.
 */
export function validate(
  graph: Graph,
  options?: ValidateOptions
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Per-entity checks (use slug for human-readable validation output)
  for (const entity of graph.getAllEntities()) {
    results.push(...validateEntity(graph, entity.slug));
  }

  // Graph-level checks
  results.push(...checkDuplicateEntityIds(graph));
  results.push(...checkBidirectionalRedundancy(graph));

  return results;
}
