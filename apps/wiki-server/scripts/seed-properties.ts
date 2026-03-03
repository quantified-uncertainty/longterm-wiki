/**
 * Seed script: data/fact-measures.yaml → properties table
 *
 * Reads the fact-measures YAML file and upserts all measures as properties.
 * Can be run standalone or imported as a function for integration tests.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/longterm_wiki_statements_epic npx tsx scripts/seed-properties.ts
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

interface MeasureDef {
  label: string;
  unit?: string;
  category: string;
  direction?: string;
  description?: string;
  display?: { divisor?: number; prefix?: string; suffix?: string; longSuffix?: string };
  relatedMeasures?: string[];
  applicableTo?: string[];
  expectedUpdateFrequency?: string;
}

interface FactMeasuresYaml {
  measures: Record<string, MeasureDef>;
  propertyAliases?: Record<string, string>;
}

/**
 * Derive the value_type from the YAML unit field.
 */
function deriveValueType(unit: string | undefined): string {
  if (!unit) return "string";
  switch (unit) {
    case "USD":
    case "count":
    case "percent":
    case "tokens":
      return "number";
    case "entity":
      return "entity";
    case "date":
      return "date";
    case "string":
      return "string";
    default:
      return "string";
  }
}

/**
 * Derive the unit_format_id from the YAML display config and unit.
 */
function deriveUnitFormatId(measure: MeasureDef): string | null {
  if (measure.display) {
    const { divisor, prefix } = measure.display;
    if (divisor === 1e9 && prefix === "$") return "usd-billions";
    if (divisor === 1e6 && prefix === "$") return "usd-millions";
  }
  // Fallback to unit-based formats
  if (measure.unit === "percent") return "percent";
  if (measure.unit === "count") return "count";
  if (measure.unit === "tokens") return "tokens";
  return null;
}

/**
 * Load and parse fact-measures.yaml.
 */
function loadFactMeasures(): FactMeasuresYaml {
  const yamlPath = path.resolve(
    __dirname,
    "../../../data/fact-measures.yaml"
  );
  const content = fs.readFileSync(yamlPath, "utf8");
  return yaml.load(content) as FactMeasuresYaml;
}

/**
 * Seed the properties table from fact-measures.yaml.
 *
 * Exported for use in integration tests.
 */
export async function seedProperties(
  db: ReturnType<typeof drizzle<typeof schema>>
): Promise<{ inserted: number; updated: number }> {
  const data = loadFactMeasures();
  const measures = data.measures;

  let inserted = 0;
  let updated = 0;

  const rows = Object.entries(measures).map(([id, measure]) => ({
    id,
    label: measure.label,
    category: measure.category,
    entityTypes: measure.applicableTo || [],
    valueType: deriveValueType(measure.unit),
    defaultUnit: measure.unit || null,
    stalenessCadence: measure.expectedUpdateFrequency || null,
    unitFormatId: deriveUnitFormatId(measure),
    rangeEntityTypes: null as string[] | null,
    inversePropertyId: null as string | null,
    isSymmetric: false,
  }));

  // Upsert each property individually to track inserted vs updated
  for (const row of rows) {
    const result = await db
      .insert(schema.properties)
      .values(row)
      .onConflictDoUpdate({
        target: schema.properties.id,
        set: {
          label: row.label,
          category: row.category,
          entityTypes: row.entityTypes,
          valueType: row.valueType,
          defaultUnit: row.defaultUnit,
          stalenessCadence: row.stalenessCadence,
          unitFormatId: row.unitFormatId,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    if (result.length > 0) {
      // Check if it was a new insert or an update by comparing timestamps
      const r = result[0];
      if (
        r.createdAt &&
        r.updatedAt &&
        Math.abs(r.createdAt.getTime() - r.updatedAt.getTime()) < 100
      ) {
        inserted++;
      } else {
        updated++;
      }
    }
  }

  return { inserted, updated };
}

// ============================================================================
// CLI entry point
// ============================================================================

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("seed-properties.ts") ||
    process.argv[1].endsWith("seed-properties.js"));

if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sqlConn = postgres(databaseUrl, { max: 3 });
  const db = drizzle(sqlConn, { schema });

  try {
    const result = await seedProperties(db);
    console.log(
      `✓ Properties seeded: ${result.inserted} inserted, ${result.updated} updated`
    );

    // Verify
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.properties);
    console.log(`  Total properties in DB: ${countResult[0].count}`);
  } catch (error) {
    console.error("Failed to seed properties:", error);
    process.exit(1);
  } finally {
    await sqlConn.end();
  }
}
