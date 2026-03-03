/**
 * Migration script: claims table → statements + statement_citations tables
 *
 * Reads claims from PostgreSQL for a given entity and inserts them as statement rows.
 * Can be run standalone or imported as a function for integration tests.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/migrate-claims-to-statements.ts
 *   DATABASE_URL=postgresql://... npx tsx scripts/migrate-claims-to-statements.ts --entity=openai
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, or } from "drizzle-orm";
import * as schema from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: number;
  entityId: string;
  claimMode: string;
  claimText: string;
  subjectEntity: string | null;
  property: string | null;
  measure: string | null;
  structuredValue: string | null;
  valueNumeric: number | null;
  valueLow: number | null;
  valueHigh: number | null;
  valueUnit: string | null;
  valueDate: string | null;
  asOf: string | null;
  qualifiers: Record<string, string> | null;
  attributedTo: string | null;
  section: string | null;
  factId: string | null;
}

interface ClaimSourceRow {
  id: number;
  claimId: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  isPrimary: boolean;
  sourceLocation: string | null;
}

interface FactMeasuresYaml {
  measures: Record<string, unknown>;
  propertyAliases?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Property alias resolution
// ---------------------------------------------------------------------------

function loadPropertyAliases(): Record<string, string> {
  const filePath = path.resolve(
    __dirname,
    "../../../data/fact-measures.yaml"
  );
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(content) as FactMeasuresYaml;
  return parsed.propertyAliases ?? {};
}

/**
 * Resolve a claim's property field (snake_case) or measure field (kebab-case)
 * to a valid property ID.
 *
 * Priority: property (via alias map) > measure (direct) > null
 */
function resolvePropertyId(
  property: string | null,
  measure: string | null,
  aliases: Record<string, string>,
  validPropertyIds: Set<string>
): string | null {
  // Try property field first (snake_case from structured claims)
  if (property) {
    const aliased = aliases[property];
    if (aliased && validPropertyIds.has(aliased)) return aliased;
    // Maybe property is already kebab-case
    if (validPropertyIds.has(property)) return property;
  }

  // Try measure field (should already be kebab-case)
  if (measure) {
    if (validPropertyIds.has(measure)) return measure;
    // Try via aliases in case measure uses snake_case
    const aliased = aliases[measure];
    if (aliased && validPropertyIds.has(aliased)) return aliased;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Parse claim value fields into statement value columns.
 *
 * Uses valueNumeric, valueLow, valueHigh, structuredValue from the claim.
 */
function parseClaimValues(claim: ClaimRow): {
  valueNumeric: number | null;
  valueText: string | null;
  valueSeries: Record<string, unknown> | null;
} {
  // Range values: valueLow + valueHigh
  if (claim.valueLow != null || claim.valueHigh != null) {
    const low = claim.valueLow;
    const high = claim.valueHigh;
    const series: Record<string, number> = {};
    if (low != null) series.low = low;
    if (high != null) series.high = high;

    let numeric = claim.valueNumeric;
    if (numeric == null && low != null && high != null) {
      numeric = (low + high) / 2;
    } else if (numeric == null) {
      numeric = low ?? high ?? null;
    }

    return { valueNumeric: numeric, valueText: null, valueSeries: series };
  }

  // Simple numeric value
  if (claim.valueNumeric != null) {
    return { valueNumeric: claim.valueNumeric, valueText: null, valueSeries: null };
  }

  // Structured value (text, only if no numeric)
  if (claim.structuredValue != null) {
    // Try parsing as number first
    const parsed = Number(claim.structuredValue);
    if (!isNaN(parsed) && claim.structuredValue.trim() !== "") {
      return { valueNumeric: parsed, valueText: null, valueSeries: null };
    }
    return { valueNumeric: null, valueText: claim.structuredValue, valueSeries: null };
  }

  return { valueNumeric: null, valueText: null, valueSeries: null };
}

/**
 * Map claimMode to statement variety.
 * - "endorsed" → "structured"
 * - "attributed" → "attributed"
 * - anything else → "structured" (safe default)
 */
function mapVariety(claimMode: string): string {
  if (claimMode === "attributed") return "attributed";
  return "structured";
}

/**
 * Serialize qualifiers: first key:value pair becomes qualifierKey,
 * remaining pairs appended to note.
 */
function processQualifiers(
  qualifiers: Record<string, string> | null
): { qualifierKey: string | null; qualifierNote: string | null } {
  if (!qualifiers || typeof qualifiers !== "object") {
    return { qualifierKey: null, qualifierNote: null };
  }

  const entries = Object.entries(qualifiers).filter(
    ([, v]) => v != null && v !== ""
  );
  if (entries.length === 0) {
    return { qualifierKey: null, qualifierNote: null };
  }

  const [firstKey, firstVal] = entries[0];
  const qualifierKey = `${firstKey}:${firstVal}`;

  const rest = entries.slice(1);
  const qualifierNote =
    rest.length > 0
      ? rest.map(([k, v]) => `${k}:${v}`).join("; ")
      : null;

  return { qualifierKey, qualifierNote };
}

// ---------------------------------------------------------------------------
// Core migration function
// ---------------------------------------------------------------------------

export interface ClaimsMigrationResult {
  inserted: number;
  skipped: number;
  deduplicated: number;
  citationsCreated: number;
  propertyResolutionFailures: number;
  warnings: string[];
  byVariety: Record<string, number>;
}

/**
 * Migrate claims for a given entity to the statements table.
 *
 * Exported for use in integration tests.
 */
export async function migrateClaims(
  db: ReturnType<typeof drizzle<typeof schema>>,
  entityFilter: string = "anthropic"
): Promise<ClaimsMigrationResult> {
  const aliases = loadPropertyAliases();

  // Pre-load valid entity IDs for FK validation
  const entityRows = await db
    .select({ id: schema.entities.id })
    .from(schema.entities);
  const validEntityIds = new Set(entityRows.map((r) => r.id));

  // Pre-load valid resource IDs for FK validation
  const resourceRows = await db
    .select({ id: schema.resources.id })
    .from(schema.resources);
  const validResourceIds = new Set(resourceRows.map((r) => r.id));

  // Pre-load valid property IDs for FK validation
  const propertyRows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties);
  const validPropertyIds = new Set(propertyRows.map((r) => r.id));

  // Pre-load existing source_fact_keys for idempotency
  const existingKeys = await db
    .select({ key: schema.statements.sourceFactKey })
    .from(schema.statements);
  const existingFactKeys = new Set(
    existingKeys.map((r) => r.key).filter(Boolean)
  );

  // Load claims for the target entity
  const claimRows = await db
    .select({
      id: schema.claims.id,
      entityId: schema.claims.entityId,
      claimMode: schema.claims.claimMode,
      claimText: schema.claims.claimText,
      subjectEntity: schema.claims.subjectEntity,
      property: schema.claims.property,
      measure: schema.claims.measure,
      structuredValue: schema.claims.structuredValue,
      valueNumeric: schema.claims.valueNumeric,
      valueLow: schema.claims.valueLow,
      valueHigh: schema.claims.valueHigh,
      valueUnit: schema.claims.valueUnit,
      valueDate: schema.claims.valueDate,
      asOf: schema.claims.asOf,
      qualifiers: schema.claims.qualifiers,
      attributedTo: schema.claims.attributedTo,
      section: schema.claims.section,
      factId: schema.claims.factId,
    })
    .from(schema.claims)
    .where(
      or(
        eq(schema.claims.entityId, entityFilter),
        eq(schema.claims.subjectEntity, entityFilter)
      )
    );

  // Load all claim sources for the matched claims
  const claimIds = claimRows.map((c) => c.id);
  let claimSourcesByClaimId: Map<number, ClaimSourceRow[]> = new Map();

  if (claimIds.length > 0) {
    // Query in batches to avoid parameter limits
    const batchSize = 500;
    for (let i = 0; i < claimIds.length; i += batchSize) {
      const batch = claimIds.slice(i, i + batchSize);
      const sourceRows = await db
        .select({
          id: schema.claimSources.id,
          claimId: schema.claimSources.claimId,
          resourceId: schema.claimSources.resourceId,
          url: schema.claimSources.url,
          sourceQuote: schema.claimSources.sourceQuote,
          isPrimary: schema.claimSources.isPrimary,
          sourceLocation: schema.claimSources.sourceLocation,
        })
        .from(schema.claimSources)
        .where(
          sql`${schema.claimSources.claimId} = ANY(${batch}::bigint[])`
        );

      for (const row of sourceRows) {
        const existing = claimSourcesByClaimId.get(row.claimId) ?? [];
        existing.push(row);
        claimSourcesByClaimId.set(row.claimId, existing);
      }
    }
  }

  let inserted = 0;
  let skipped = 0;
  let deduplicated = 0;
  let citationsCreated = 0;
  let propertyResolutionFailures = 0;
  const warnings: string[] = [];
  const byVariety: Record<string, number> = {};

  // Wrap in a transaction for atomicity
  await db.transaction(async (tx) => {
    for (const claim of claimRows) {
      const sourceFactKey = `claim:${claim.id}`;

      // Idempotency: skip if already migrated
      if (existingFactKeys.has(sourceFactKey)) {
        skipped++;
        continue;
      }

      // Dedup with YAML facts: if claim has factId matching an existing statement
      if (claim.factId && existingFactKeys.has(claim.factId)) {
        deduplicated++;
        continue;
      }

      // Determine the subject entity
      const subjectEntityId = claim.subjectEntity || claim.entityId;

      // Validate subject entity exists
      if (!validEntityIds.has(subjectEntityId)) {
        warnings.push(
          `Skipped claim:${claim.id}: subject entity '${subjectEntityId}' not found`
        );
        skipped++;
        continue;
      }

      // Resolve property
      const propertyId = resolvePropertyId(
        claim.property,
        claim.measure,
        aliases,
        validPropertyIds
      );

      if (!propertyId && (claim.property || claim.measure)) {
        propertyResolutionFailures++;
        warnings.push(
          `claim:${claim.id}: property '${claim.property || claim.measure}' not resolved to a valid property`
        );
      }

      // Parse values
      const { valueNumeric, valueText, valueSeries } = parseClaimValues(claim);

      // Map variety
      const variety = mapVariety(claim.claimMode);
      byVariety[variety] = (byVariety[variety] ?? 0) + 1;

      // Process qualifiers
      const { qualifierKey, qualifierNote } = processQualifiers(claim.qualifiers);

      // Build note
      const noteParts: string[] = [];
      if (claim.section) noteParts.push(`[section: ${claim.section}]`);
      if (qualifierNote) noteParts.push(qualifierNote);
      const note = noteParts.length > 0 ? noteParts.join(" ") : null;

      // Validate attributedTo FK
      const attributedTo =
        claim.attributedTo && validEntityIds.has(claim.attributedTo)
          ? claim.attributedTo
          : null;

      if (claim.attributedTo && !validEntityIds.has(claim.attributedTo)) {
        warnings.push(
          `claim:${claim.id}: attributedTo '${claim.attributedTo}' not found in entities; set to null`
        );
      }

      // Build the statement row
      const statementRow = {
        variety,
        statementText: claim.claimText,
        subjectEntityId,
        propertyId,
        valueNumeric,
        valueText,
        valueEntityId: null as string | null,
        valueDate: claim.valueDate ?? null,
        valueSeries: valueSeries as Record<string, unknown> | null,
        valueUnit: claim.valueUnit ?? null,
        qualifierKey,
        validStart: claim.asOf ?? null,
        validEnd: null as string | null,
        attributedTo,
        status: "active" as const,
        sourceFactKey,
        note,
      };

      // Insert statement
      const result = await tx
        .insert(schema.statements)
        .values(statementRow)
        .returning({ id: schema.statements.id });

      if (result.length === 0) {
        warnings.push(`Failed to insert statement for claim:${claim.id}`);
        skipped++;
        continue;
      }

      inserted++;
      const statementId = result[0].id;

      // Migrate claim sources → statement citations
      const sources = claimSourcesByClaimId.get(claim.id) ?? [];
      for (const source of sources) {
        const resourceId =
          source.resourceId && validResourceIds.has(source.resourceId)
            ? source.resourceId
            : null;

        const citationRow = {
          statementId,
          resourceId,
          url: source.url ?? null,
          sourceQuote: source.sourceQuote ?? null,
          locationNote: source.sourceLocation ?? null,
          isPrimary: source.isPrimary,
        };

        await tx.insert(schema.statementCitations).values(citationRow);
        citationsCreated++;

        if (source.resourceId && !validResourceIds.has(source.resourceId)) {
          warnings.push(
            `claim:${claim.id}: claimSource resourceId '${source.resourceId}' not found; citation created without resource_id`
          );
        }
      }
    }
  });

  return {
    inserted,
    skipped,
    deduplicated,
    citationsCreated,
    propertyResolutionFailures,
    warnings,
    byVariety,
  };
}

// ============================================================================
// CLI entry point
// ============================================================================

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-claims-to-statements.ts") ||
    process.argv[1].endsWith("migrate-claims-to-statements.js"));

if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  // Parse --entity flag
  const entityArg = process.argv.find((a) => a.startsWith("--entity="));
  const entityFilter = entityArg ? entityArg.split("=")[1] : "anthropic";

  const sqlConn = postgres(databaseUrl, { max: 3 });
  const db = drizzle(sqlConn, { schema });

  try {
    console.log(`Migrating claims for entity: ${entityFilter}`);
    const result = await migrateClaims(db, entityFilter);

    console.log(`\n--- Migration Summary ---`);
    console.log(`  Inserted:     ${result.inserted}`);
    console.log(`  Skipped:      ${result.skipped} (already migrated)`);
    console.log(`  Deduplicated: ${result.deduplicated} (matched YAML facts)`);
    console.log(`  Citations:    ${result.citationsCreated}`);
    console.log(`  Property resolution failures: ${result.propertyResolutionFailures}`);

    console.log(`\n  By variety:`);
    for (const [variety, count] of Object.entries(result.byVariety)) {
      console.log(`    ${variety}: ${count}`);
    }

    if (result.warnings.length > 0) {
      console.log(`\n⚠ Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }

    // Verify totals
    const stmtCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements);
    console.log(`\n  Total statements in DB: ${stmtCount[0].count}`);

    const citCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statementCitations);
    console.log(`  Total statement_citations in DB: ${citCount[0].count}`);

    // Quality review: property resolution
    const nullPropCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%' AND ${schema.statements.propertyId} IS NULL`
      );
    console.log(
      `\n  Claim-sourced statements with null propertyId: ${nullPropCount[0].count}`
    );
  } catch (error) {
    console.error("Failed to migrate claims:", error);
    process.exit(1);
  } finally {
    await sqlConn.end();
  }
}
