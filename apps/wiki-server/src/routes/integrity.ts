import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";

export const integrityRoute = new Hono();

interface IntegrityIssue {
  table: string;
  column: string;
  target_table: string;
  missing_refs: string[];
  count: number;
}

/**
 * Run a dangling-reference check and return an issue if any are found.
 * Returns null if the table is clean.
 */
async function checkDangling(
  db: ReturnType<typeof getDrizzleDb>,
  query: ReturnType<typeof sql>,
  table: string,
  column: string,
  targetTable: string
): Promise<IntegrityIssue | null> {
  const rows = (await db.execute(query)) as Array<{ ref: string }>;
  if (rows.length === 0) return null;
  return {
    table,
    column,
    target_table: targetTable,
    missing_refs: rows.map((r) => r.ref),
    count: rows.length,
  };
}

// ---- GET / ----

integrityRoute.get("/", async (c) => {
  const db = getDrizzleDb();
  const issues: IntegrityIssue[] = [];

  const checks = [
    // 1. facts.entity_id → entities
    checkDangling(
      db,
      sql`SELECT DISTINCT entity_id AS ref FROM facts WHERE entity_id NOT IN (SELECT id FROM entities)`,
      "facts",
      "entity_id",
      "entities"
    ),
    // 2. facts.source_resource → resources
    checkDangling(
      db,
      sql`SELECT DISTINCT source_resource AS ref FROM facts WHERE source_resource IS NOT NULL AND source_resource NOT IN (SELECT id FROM resources)`,
      "facts",
      "source_resource",
      "resources"
    ),
    // 3. claims.entity_id → entities
    checkDangling(
      db,
      sql`SELECT DISTINCT entity_id AS ref FROM claims WHERE entity_id NOT IN (SELECT id FROM entities)`,
      "claims",
      "entity_id",
      "entities"
    ),
    // 4. summaries.entity_id → entities
    checkDangling(
      db,
      sql`SELECT DISTINCT entity_id AS ref FROM summaries WHERE entity_id NOT IN (SELECT id FROM entities)`,
      "summaries",
      "entity_id",
      "entities"
    ),
    // 5. citation_quotes.page_id → wiki_pages
    checkDangling(
      db,
      sql`SELECT DISTINCT page_id AS ref FROM citation_quotes WHERE page_id NOT IN (SELECT id FROM wiki_pages)`,
      "citation_quotes",
      "page_id",
      "wiki_pages"
    ),
    // 6. citation_quotes.resource_id → resources
    checkDangling(
      db,
      sql`SELECT DISTINCT resource_id AS ref FROM citation_quotes WHERE resource_id IS NOT NULL AND resource_id NOT IN (SELECT id FROM resources)`,
      "citation_quotes",
      "resource_id",
      "resources"
    ),
    // 7. edit_logs.page_id → wiki_pages
    checkDangling(
      db,
      sql`SELECT DISTINCT page_id AS ref FROM edit_logs WHERE page_id NOT IN (SELECT id FROM wiki_pages)`,
      "edit_logs",
      "page_id",
      "wiki_pages"
    ),
    // 8. entities.relatedEntries JSONB → entities
    checkDangling(
      db,
      sql`SELECT DISTINCT elem->>'id' AS ref FROM entities, jsonb_array_elements(related_entries) AS elem WHERE related_entries IS NOT NULL AND (elem->>'id') NOT IN (SELECT id FROM entities)`,
      "entities",
      "related_entries[].id",
      "entities"
    ),
    // 9. resource_citations.page_id → wiki_pages
    checkDangling(
      db,
      sql`SELECT DISTINCT page_id AS ref FROM resource_citations WHERE page_id NOT IN (SELECT id FROM wiki_pages)`,
      "resource_citations",
      "page_id",
      "wiki_pages"
    ),
  ];

  const results = await Promise.all(checks);
  for (const result of results) {
    if (result) issues.push(result);
  }

  const tablesChecked = checks.length;
  const totalDangling = issues.reduce((sum, i) => sum + i.count, 0);

  return c.json({
    status: issues.length === 0 ? "clean" : "issues_found",
    checked_at: new Date().toISOString(),
    issues,
    summary: {
      tables_checked: tablesChecked,
      issues_found: issues.length,
      total_dangling_refs: totalDangling,
    },
  });
});
