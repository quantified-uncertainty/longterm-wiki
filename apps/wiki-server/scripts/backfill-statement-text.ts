/**
 * Backfill script: Generate statementText for statements that lack it.
 *
 * The Statements V2 design requires every statement to have human-readable
 * statementText. Structured statements migrated from YAML facts typically
 * have null statementText. This script generates it from structured fields.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/backfill-statement-text.ts
 *   DATABASE_URL=postgresql://... npx tsx scripts/backfill-statement-text.ts --dry-run
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, isNull } from "drizzle-orm";
import * as schema from "../src/schema.js";

const dryRun = process.argv.includes("--dry-run");

type StatementRow = typeof schema.statements.$inferSelect;

interface PropertyRow {
  id: string;
  label: string;
  unitFormatId: string | null;
  defaultUnit: string | null;
}

interface EntityRow {
  id: string;
  title: string;
}

/**
 * Format a numeric value with basic unit display.
 */
function formatValue(value: number, unit: string | null, unitFormatId: string | null): string {
  if (unitFormatId === "usd-billions" || (unit === "USD" && Math.abs(value) >= 1e9)) {
    const billions = value / 1e9;
    return `$${billions % 1 === 0 ? billions.toFixed(0) : billions.toFixed(1)}B`;
  }
  if (unitFormatId === "usd-millions" || (unit === "USD" && Math.abs(value) >= 1e6)) {
    const millions = value / 1e6;
    return `$${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (unit === "USD") {
    return `$${value.toLocaleString("en-US")}`;
  }
  if (unit === "percent" || unitFormatId === "percent") {
    return `${value}%`;
  }
  if (unit === "count" || unitFormatId === "count") {
    return value.toLocaleString("en-US");
  }
  return value.toLocaleString("en-US");
}

/**
 * Format a qualifier key as a readable prefix.
 */
function formatQualifier(key: string | null): string {
  if (!key) return "";
  switch (key) {
    case "at-least": return "at least ";
    case "at-most": return "at most ";
    case "around": return "approximately ";
    case "exactly": return "";
    default: return `${key}: `;
  }
}

/**
 * Format a period string for readable display.
 */
function formatPeriod(validStart: string | null, validEnd: string | null): string {
  if (!validStart && !validEnd) return "";
  if (validStart && !validEnd) {
    // Parse partial dates
    if (/^\d{4}$/.test(validStart)) return ` (${validStart})`;
    if (/^\d{4}-\d{2}$/.test(validStart)) {
      const [year, month] = validStart.split("-");
      const monthIdx = parseInt(month, 10) - 1;
      if (monthIdx >= 0 && monthIdx <= 11) {
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return ` (${monthNames[monthIdx]} ${year})`;
      }
    }
    return ` (${validStart})`;
  }
  if (validStart && validEnd) {
    return ` (${validStart} to ${validEnd})`;
  }
  return "";
}

/**
 * Generate statementText for a structured statement.
 */
function generateStructuredText(
  stmt: StatementRow,
  propertyMap: Map<string, PropertyRow>,
  entityMap: Map<string, EntityRow>
): string {
  const entity = entityMap.get(stmt.subjectEntityId);
  const entityName = entity?.title || stmt.subjectEntityId;
  const property = stmt.propertyId ? propertyMap.get(stmt.propertyId) : null;
  const propertyLabel = property?.label || stmt.propertyId || "value";
  const period = formatPeriod(stmt.validStart, stmt.validEnd);
  const qualifier = formatQualifier(stmt.qualifierKey);

  // Build value string
  let valueStr = "";
  if (stmt.valueNumeric != null) {
    valueStr = formatValue(stmt.valueNumeric, stmt.valueUnit || property?.defaultUnit || null, property?.unitFormatId || null);
  } else if (stmt.valueText != null) {
    valueStr = stmt.valueText;
  } else if (stmt.valueDate != null) {
    valueStr = stmt.valueDate;
  } else if (stmt.valueEntityId != null) {
    const valueEntity = entityMap.get(stmt.valueEntityId);
    valueStr = valueEntity?.title || stmt.valueEntityId;
  } else if (stmt.valueSeries != null) {
    const series = stmt.valueSeries as { low?: number; high?: number };
    if (typeof series.low === "number" && typeof series.high === "number") {
      const unit = stmt.valueUnit || property?.defaultUnit || null;
      const formatId = property?.unitFormatId || null;
      valueStr = `${formatValue(series.low, unit, formatId)} to ${formatValue(series.high, unit, formatId)}`;
    } else {
      valueStr = JSON.stringify(stmt.valueSeries);
    }
  }

  if (valueStr) {
    // "[Entity]'s [property] was [qualifier][value] ([period])"
    return `${entityName}'s ${propertyLabel.toLowerCase()} was ${qualifier}${valueStr}${period}.`;
  }

  // No typed value — use note or property label as fallback
  if (stmt.note) {
    return `${entityName}: ${stmt.note}${period}.`;
  }

  return `${entityName}: ${propertyLabel.toLowerCase()}${period}.`;
}

/**
 * Generate statementText for an attributed statement.
 */
function generateAttributedText(
  stmt: StatementRow,
  entityMap: Map<string, EntityRow>
): string {
  // Attributed statements should already have statementText, but if not:
  const entity = entityMap.get(stmt.subjectEntityId);
  const entityName = entity?.title || stmt.subjectEntityId;
  const attributor = stmt.attributedTo ? entityMap.get(stmt.attributedTo) : null;
  const attributorName = attributor?.title || stmt.attributedTo || "Unknown";

  if (stmt.note) {
    return `${attributorName} stated regarding ${entityName}: ${stmt.note}`;
  }

  return `Statement about ${entityName} attributed to ${attributorName}.`;
}

// ============================================================================
// Main
// ============================================================================

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sqlConn = postgres(databaseUrl, { max: 3 });
const db = drizzle(sqlConn, { schema });

try {
  // Step 1: Load property and entity maps
  console.log("Loading properties...");
  const allProperties = await db.select().from(schema.properties);
  const propertyMap = new Map<string, PropertyRow>(
    allProperties.map((p) => [p.id, { id: p.id, label: p.label, unitFormatId: p.unitFormatId, defaultUnit: p.defaultUnit }])
  );
  console.log(`  Loaded ${propertyMap.size} properties`);

  console.log("Loading entities...");
  const allEntities = await db
    .select({ id: schema.entities.id, title: schema.entities.title })
    .from(schema.entities);
  const entityMap = new Map<string, EntityRow>(
    allEntities.map((e) => [e.id, { id: e.id, title: e.title }])
  );
  console.log(`  Loaded ${entityMap.size} entities`);

  // Step 2: Find statements with null statementText
  console.log("Finding statements without statementText...");
  const statementsToFill = await db
    .select()
    .from(schema.statements)
    .where(
      sql`${schema.statements.statementText} IS NULL OR btrim(${schema.statements.statementText}) = ''`
    );

  console.log(`  Found ${statementsToFill.length} statements needing text`);

  if (statementsToFill.length === 0) {
    console.log("✓ All statements already have statementText");
    await sqlConn.end();
    process.exit(0);
  }

  // Step 3: Generate text for each
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const stmt of statementsToFill) {
    try {
      let text: string;
      if (stmt.variety === "attributed") {
        text = generateAttributedText(stmt, entityMap);
      } else {
        text = generateStructuredText(stmt, propertyMap, entityMap);
      }

      // Clean up: remove double periods, trim
      text = text.replace(/\.\./g, ".").trim();

      if (dryRun) {
        if (updated < 10) {
          console.log(`  [DRY RUN] Statement ${stmt.id}: "${text}"`);
        }
        updated++;
      } else {
        await db
          .update(schema.statements)
          .set({
            statementText: text,
            updatedAt: sql`now()`,
          })
          .where(sql`${schema.statements.id} = ${stmt.id}`);
        updated++;
      }
    } catch (err) {
      errors.push(`Statement ${stmt.id}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  // Step 4: Report
  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (errors): ${skipped}`);
  if (errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`    - ${e}`);
    }
    if (errors.length > 10) {
      console.log(`    ... and ${errors.length - 10} more`);
    }
  }

  // Step 5: Verify
  if (!dryRun) {
    const remaining = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements)
      .where(isNull(schema.statements.statementText));
    console.log(`\n  Remaining without text: ${remaining[0].count}`);
  }

  console.log(`\n✓ Backfill complete`);
} catch (error) {
  console.error("Backfill failed:", error);
  process.exit(1);
} finally {
  await sqlConn.end();
}
