/**
 * Migration script: data/facts/*.yaml → statements + statement_citations tables
 *
 * Reads all YAML fact files and inserts them as statement rows.
 * Can be run standalone or imported as a function for integration tests.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/longterm_wiki_statements_epic npx tsx scripts/migrate-facts-to-statements.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types for the YAML fact structure
// ---------------------------------------------------------------------------

interface FactDef {
  value: number | string | number[] | { min?: number; max?: number };
  label?: string;
  measure?: string | null;
  asOf?: string | number;
  note?: string;
  source?: string;
  sourceResource?: string;
  subject?: string;
  noCompute?: boolean;
}

interface FactFileYaml {
  entity: string;
  facts: Record<string, FactDef>;
}

// ---------------------------------------------------------------------------
// Value parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a fact value into numeric, text, and series components.
 *
 * - Simple number → valueNumeric
 * - String → valueText
 * - Array [low, high] → valueNumeric (midpoint), valueSeries {low, high}
 * - Object {min: N} → valueNumeric: N, valueSeries {min: N}
 * - Object {max: N} → valueNumeric: N, valueSeries {max: N}
 * - Object {min: N, max: M} → valueNumeric (midpoint), valueSeries {min, max}
 */
function parseFactValue(value: FactDef["value"]): {
  valueNumeric: number | null;
  valueText: string | null;
  valueSeries: Record<string, unknown> | null;
} {
  // Array range: [low, high]
  if (Array.isArray(value)) {
    const nums = value.filter((v): v is number => typeof v === "number");
    if (nums.length === 2) {
      const midpoint = (nums[0] + nums[1]) / 2;
      return {
        valueNumeric: midpoint,
        valueText: null,
        valueSeries: { low: nums[0], high: nums[1] },
      };
    }
    // Single-element array or empty — treat as text
    return {
      valueNumeric: null,
      valueText: JSON.stringify(value),
      valueSeries: null,
    };
  }

  // Object with min/max
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as { min?: number; max?: number };
    const hasMin = typeof obj.min === "number";
    const hasMax = typeof obj.max === "number";

    if (hasMin && hasMax) {
      return {
        valueNumeric: (obj.min! + obj.max!) / 2,
        valueText: null,
        valueSeries: { min: obj.min, max: obj.max },
      };
    }
    if (hasMin) {
      return {
        valueNumeric: obj.min!,
        valueText: null,
        valueSeries: { min: obj.min },
      };
    }
    if (hasMax) {
      return {
        valueNumeric: obj.max!,
        valueText: null,
        valueSeries: { max: obj.max },
      };
    }
    // Unknown object shape — serialize as text
    return {
      valueNumeric: null,
      valueText: JSON.stringify(value),
      valueSeries: null,
    };
  }

  // Simple number
  if (typeof value === "number") {
    return {
      valueNumeric: value,
      valueText: null,
      valueSeries: null,
    };
  }

  // String value (e.g., "2028", "75%", "1,700%")
  return {
    valueNumeric: null,
    valueText: String(value),
    valueSeries: null,
  };
}

/**
 * Normalize asOf to a text string suitable for valid_start.
 * YAML may parse dates like 2026-02 as Date objects; we need text.
 */
function normalizeAsOf(asOf: string | number | Date | undefined): string | null {
  if (asOf === undefined || asOf === null) return null;

  // If YAML parsed it as a Date object (e.g., 2025-02-01)
  if (asOf instanceof Date) {
    return (asOf as Date).toISOString().slice(0, 10);
  }

  // Number (e.g., 2025) → string
  if (typeof asOf === "number") {
    return String(asOf);
  }

  return String(asOf);
}

// ---------------------------------------------------------------------------
// Core migration function
// ---------------------------------------------------------------------------

/**
 * Load all fact YAML files from data/facts/.
 */
function loadAllFactFiles(): FactFileYaml[] {
  const factsDir = path.resolve(__dirname, "../../../data/facts");
  const files = fs.readdirSync(factsDir).filter((f) => f.endsWith(".yaml"));
  const results: FactFileYaml[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(factsDir, file), "utf8");
    const parsed = yaml.load(content) as FactFileYaml;
    if (parsed && parsed.entity && parsed.facts) {
      results.push(parsed);
    }
  }

  return results;
}

export interface MigrationResult {
  inserted: number;
  skipped: number;
  citationsCreated: number;
  warnings: string[];
}

/**
 * Migrate all YAML facts to the statements table.
 *
 * Exported for use in integration tests.
 */
export async function migrateFacts(
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<MigrationResult> {
  const factFiles = loadAllFactFiles();

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

  let inserted = 0;
  let skipped = 0;
  let citationsCreated = 0;
  const warnings: string[] = [];

  // Wrap in a transaction for atomicity
  await db.transaction(async (tx) => {
    for (const factFile of factFiles) {
      const entityId = factFile.entity;

      for (const [factId, fact] of Object.entries(factFile.facts)) {
        const sourceFactKey = `${entityId}.${factId}`;

        // Idempotency: skip if already migrated
        if (existingFactKeys.has(sourceFactKey)) {
          skipped++;
          continue;
        }

        // Determine the subject entity
        const subjectEntityId = fact.subject || entityId;

        // Validate subject entity exists
        if (!validEntityIds.has(subjectEntityId)) {
          warnings.push(
            `Skipped ${sourceFactKey}: subject entity '${subjectEntityId}' not found in entities table`
          );
          skipped++;
          continue;
        }

        // Parse the value
        const { valueNumeric, valueText, valueSeries } = parseFactValue(
          fact.value
        );

        // Normalize measure (YAML null `~` becomes JS null)
        const propertyId = fact.measure || null;

        // Validate property exists if non-null
        if (propertyId && !validPropertyIds.has(propertyId)) {
          warnings.push(
            `Skipped ${sourceFactKey}: property '${propertyId}' not found in properties table (run seed-properties first)`
          );
          skipped++;
          continue;
        }

        // Build the statement row
        const statementRow = {
          variety: "structured" as const,
          subjectEntityId,
          propertyId,
          valueNumeric,
          valueText,
          valueEntityId: null as string | null,
          valueDate: null as string | null,
          valueSeries: valueSeries as Record<string, unknown> | null,
          qualifierKey: null as string | null,
          validStart: normalizeAsOf(fact.asOf),
          validEnd: null as string | null,
          attributedTo: null as string | null,
          status: "active" as const,
          sourceFactKey,
          note: fact.note || null,
        };

        // Insert statement
        const result = await tx
          .insert(schema.statements)
          .values(statementRow)
          .returning({ id: schema.statements.id });

        if (result.length === 0) {
          warnings.push(
            `Failed to insert statement for ${sourceFactKey}`
          );
          skipped++;
          continue;
        }

        inserted++;
        const statementId = result[0].id;

        // Create citation if source or sourceResource is present
        if (fact.sourceResource || fact.source) {
          const resourceId =
            fact.sourceResource && validResourceIds.has(fact.sourceResource)
              ? fact.sourceResource
              : null;

          const citationRow = {
            statementId,
            resourceId,
            url: fact.source || null,
            sourceQuote: null as string | null,
            locationNote: null as string | null,
            isPrimary: true,
          };

          await tx.insert(schema.statementCitations).values(citationRow);
          citationsCreated++;

          // Warn if sourceResource was provided but not found
          if (fact.sourceResource && !validResourceIds.has(fact.sourceResource)) {
            warnings.push(
              `${sourceFactKey}: sourceResource '${fact.sourceResource}' not found in resources table; citation created without resource_id`
            );
          }
        }
      }
    }
  });

  return { inserted, skipped, citationsCreated, warnings };
}

// ============================================================================
// CLI entry point
// ============================================================================

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-facts-to-statements.ts") ||
    process.argv[1].endsWith("migrate-facts-to-statements.js"));

if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sqlConn = postgres(databaseUrl, { max: 3 });
  const db = drizzle(sqlConn, { schema });

  try {
    const result = await migrateFacts(db);
    console.log(
      `✓ Facts migrated: ${result.inserted} statements inserted, ${result.skipped} skipped, ${result.citationsCreated} citations created`
    );

    if (result.warnings.length > 0) {
      console.log(`\n⚠ Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }

    // Verify
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements);
    console.log(`\n  Total statements in DB: ${countResult[0].count}`);

    const citCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statementCitations);
    console.log(`  Total statement_citations in DB: ${citCount[0].count}`);
  } catch (error) {
    console.error("Failed to migrate facts:", error);
    process.exit(1);
  } finally {
    await sqlConn.end();
  }
}
