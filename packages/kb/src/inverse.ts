/**
 * Computes inverse relationships from property definitions and adds derived
 * facts to the graph.
 *
 * For every property that declares an `inverseId`, this module scans all
 * existing facts that use that property and — for each ref/refs value —
 * synthesises a mirror fact on the referenced thing using the inverse
 * property ID.  The derived fact carries the same temporal bounds (asOf,
 * validEnd) as its source and records the source fact's ID in `derivedFrom`.
 *
 * Derived fact IDs are content-addressed: `inv_` + first-8 chars of a
 * SHA-256 hash of (subjectId + propertyId + value).  This makes the
 * operation idempotent — running it twice on the same graph produces the
 * same IDs and `addFact` will just push a duplicate; callers should only
 * run this once per graph lifecycle.
 */

import { createHash } from "node:crypto";
import type { Fact } from "./types";
import type { Graph } from "./graph";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a deterministic 8-character hex token for use in derived fact IDs.
 * Inputs are null-byte separated to prevent accidental collisions.
 */
function inverseHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\x00"), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Builds the ID for a single derived inverse fact.
 * Format: `inv_` + 12-char content hash.
 *
 * Includes asOf and validEnd in the hash so that distinct temporal
 * relationships (e.g., someone leaves and rejoins an org) get different IDs.
 */
function derivedId(
  subjectId: string,
  propertyId: string,
  refValue: string,
  asOf?: string,
  validEnd?: string,
): string {
  return `inv_${inverseHash([subjectId, propertyId, refValue, asOf ?? "", validEnd ?? ""])}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans the graph for facts that belong to properties with an `inverseId`,
 * then synthesises and adds the corresponding mirror facts on the referenced
 * things.
 *
 * Only `ref` and `refs` value types participate in inverse computation.
 * All other value types are silently skipped.
 *
 * Edge cases:
 * - If the referenced thing does not exist in the graph, a console warning is
 *   emitted and the inverse is skipped (no crash).
 * - Temporal bounds (`asOf`, `validEnd`) are preserved from the source fact.
 * - Running this function more than once on the same graph will result in
 *   duplicate facts (same `derivedFrom` ID).  Call it exactly once per graph.
 */
export function computeInverses(graph: Graph): void {
  const allProperties = graph.getAllProperties();

  for (const property of allProperties) {
    const { inverseId } = property;
    if (!inverseId) continue;

    // Skip computed properties — they are filled by the inverse of their
    // counterpart.  Processing them would create duplicates.
    if (property.computed) continue;

    // Collect all facts across every thing that use this property.
    const allThings = graph.getAllThings();

    for (const thing of allThings) {
      const facts = graph.getFacts(thing.id, { property: property.id });

      for (const fact of facts) {
        // Skip facts that are already derived (from a previous inverse pass).
        if (fact.derivedFrom) continue;
        _processFactInverse(graph, fact, inverseId);
      }
    }
  }
}

/**
 * Creates and adds a single derived inverse fact, given a source fact that
 * has a `ref` or `refs` value.  For `refs`, one inverse fact is created per
 * referenced ID.
 */
function _processFactInverse(
  graph: Graph,
  sourceFact: Fact,
  inversePropertyId: string
): void {
  const { value } = sourceFact;

  if (value.type === "ref") {
    _addSingleInverse(graph, sourceFact, inversePropertyId, value.value);
  } else if (value.type === "refs") {
    for (const refId of value.value) {
      _addSingleInverse(graph, sourceFact, inversePropertyId, refId);
    }
  }
  // All other value types (number, text, date, boolean, json) are skipped.
}

/**
 * Constructs and adds one derived inverse fact.
 * Skips silently (with a warning) if the referenced thing is not in the graph.
 */
function _addSingleInverse(
  graph: Graph,
  sourceFact: Fact,
  inversePropertyId: string,
  referencedThingId: string
): void {
  // Guard: the referenced thing must exist.
  if (!graph.getThing(referencedThingId)) {
    console.warn(
      `[kb/inverse] Skipping inverse for fact "${sourceFact.id}": ` +
        `referenced thing "${referencedThingId}" not found in graph.`
    );
    return;
  }

  const id = derivedId(
    referencedThingId,
    inversePropertyId,
    sourceFact.subjectId,
    sourceFact.asOf,
    sourceFact.validEnd,
  );

  const derived: Fact = {
    id,
    subjectId: referencedThingId,
    propertyId: inversePropertyId,
    value: { type: "ref", value: sourceFact.subjectId },
    asOf: sourceFact.asOf,
    validEnd: sourceFact.validEnd,
    derivedFrom: sourceFact.id,
  };

  graph.addFact(derived);
}
