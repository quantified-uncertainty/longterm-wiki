/**
 * Pure utility functions for processing statements.
 * Server-safe — no React imports.
 */

import { formatStatementValue } from "@lib/statement-display";
import type {
  StatementWithDetails,
  ResolvedStatement,
} from "@lib/statement-types";

// ---- Entity Resolution ----

type EntityResolver = (id: string) => { title?: string } | undefined;

/**
 * Resolve valueEntityId and attributedTo slugs to display titles.
 */
export function resolveEntityNames(
  statements: StatementWithDetails[],
  resolver: EntityResolver
): ResolvedStatement[] {
  return statements.map((s) => ({
    ...s,
    valueEntityTitle: s.valueEntityId
      ? (resolver(s.valueEntityId)?.title ?? null)
      : null,
    attributedToTitle: s.attributedTo
      ? (resolver(s.attributedTo)?.title ?? null)
      : null,
  }));
}

// ---- Composite Key ----

/** Composite key that distinguishes qualified variants of the same property. */
function snapshotKey(s: { propertyId: string | null; qualifierKey: string | null }): string {
  return `${s.propertyId ?? ""}::${s.qualifierKey ?? ""}`;
}

// ---- Current Snapshot ----

/**
 * For each unique property+qualifier among active statements, pick the "current" one:
 * validEnd === null, highest validStart. Returns a map of compositeKey → statement.
 */
export function computeCurrentSnapshot(
  structured: ResolvedStatement[]
): Map<string, ResolvedStatement> {
  const snapshot = new Map<string, ResolvedStatement>();

  const active = structured.filter(
    (s) => s.status === "active" && s.propertyId && s.validEnd === null
  );

  for (const s of active) {
    const key = snapshotKey(s);
    const existing = snapshot.get(key);
    if (
      !existing ||
      (s.validStart ?? "") > (existing.validStart ?? "")
    ) {
      snapshot.set(key, s);
    }
  }

  return snapshot;
}

// ---- Conflict Detection ----

/**
 * Find active statements with validEnd === null but different formatted values
 * for the same propertyId. Returns only entries with 2+ disagreeing values.
 */
export function detectConflicts(
  structured: ResolvedStatement[]
): Map<string, ResolvedStatement[]> {
  const byProperty = new Map<string, ResolvedStatement[]>();

  const active = structured.filter(
    (s) => s.status === "active" && s.propertyId && s.validEnd === null
  );

  for (const s of active) {
    const key = snapshotKey(s);
    const list = byProperty.get(key) ?? [];
    list.push(s);
    byProperty.set(key, list);
  }

  const conflicts = new Map<string, ResolvedStatement[]>();
  for (const [key, stmts] of byProperty) {
    if (stmts.length < 2) continue;

    // Check if values actually differ
    const values = new Set(
      stmts.map((s) => formatStatementValue(s, s.property))
    );
    if (values.size > 1) {
      conflicts.set(key, stmts);
    }
  }

  return conflicts;
}

// ---- Category Grouping ----

/**
 * Group statements by property.category, sorted by size descending.
 * Null-property text claims go into "text claims".
 */
export function groupByCategory(
  structured: ResolvedStatement[]
): [string, ResolvedStatement[]][] {
  const map = new Map<string, ResolvedStatement[]>();

  for (const s of structured) {
    const cat =
      s.property?.category ??
      (s.statementText ? "text claims" : "uncategorized");
    if (!cat) continue;
    const list = map.get(cat) ?? [];
    list.push(s);
    map.set(cat, list);
  }

  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}
