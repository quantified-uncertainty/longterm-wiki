import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { applyTruncation } from "../shared/utils.js";

interface IntegrityIssue {
  table: string;
  column: string;
  target_table: string;
  missing_refs: string[];
  count: number;
  truncated: boolean;
}

// QUA-623: cap each SELECT DISTINCT to prevent a data-integrity regression
// from OOMing the response or hitting statement_timeout. If refs exceed the
// cap, we return the capped list and set `truncated: true` — the number of
// dangling refs is a red flag either way, the exact count can be re-queried.
const MAX_MISSING_REFS = 1000;

/**
 * Run a dangling-reference check and return an issue if any are found.
 * Returns null if the table is clean.
 *
 * The caller's SQL should NOT include its own LIMIT — we append one with a
 * +1 sentinel to detect truncation.
 */
async function checkDangling(
  db: ReturnType<typeof getDrizzleDb>,
  query: ReturnType<typeof sql>,
  table: string,
  column: string,
  targetTable: string
): Promise<IntegrityIssue | null> {
  const capped = sql`${query} LIMIT ${MAX_MISSING_REFS + 1}`;
  const rows = (await db.execute(capped)) as Array<{ ref: string }>;
  if (rows.length === 0) return null;
  const { items, truncated } = applyTruncation(rows, MAX_MISSING_REFS);
  return {
    table,
    column,
    target_table: targetTable,
    missing_refs: items.map((r) => r.ref),
    count: items.length,
    truncated,
  };
}

// ---- GET / ----

const integrityApp = new Hono()
  .get("/", async (c) => {
    const db = getDrizzleDb();
    const issues: IntegrityIssue[] = [];

    const checks = [
      // 1. facts.entity_id → entities.stable_id
      checkDangling(
        db,
        sql`SELECT DISTINCT f.entity_id AS ref FROM facts f WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = f.entity_id)`,
        "facts",
        "entity_id",
        "entities"
      ),
      // 2. summaries.entity_id → entities.stable_id
      checkDangling(
        db,
        sql`SELECT DISTINCT s.entity_id AS ref FROM summaries s WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = s.entity_id)`,
        "summaries",
        "entity_id",
        "entities"
      ),
      // 4. citation_quotes.page_id → wiki_pages
      // Catches both NULL page_id (unresolved) and non-NULL values with no matching wiki_page
      checkDangling(
        db,
        sql`SELECT DISTINCT cq.page_id::text AS ref FROM citation_quotes cq WHERE cq.page_id IS NULL OR NOT EXISTS (SELECT 1 FROM wiki_pages wp WHERE wp.id = cq.page_id)`,
        "citation_quotes",
        "page_id",
        "wiki_pages"
      ),
      // 5. citation_quotes.resource_id → resources.stable_id
      // QUA-574 Phase B.2b: resource_id now references resources.stable_id (not resources.id).
      checkDangling(
        db,
        sql`SELECT DISTINCT cq.resource_id AS ref FROM citation_quotes cq WHERE cq.resource_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = cq.resource_id)`,
        "citation_quotes",
        "resource_id",
        "resources"
      ),
      // 6. edit_logs.page_id → wiki_pages
      // Catches both NULL page_id (unresolved) and non-NULL values with no matching wiki_page
      checkDangling(
        db,
        sql`SELECT DISTINCT el.page_id::text AS ref FROM edit_logs el WHERE el.page_id IS NULL OR NOT EXISTS (SELECT 1 FROM wiki_pages wp WHERE wp.id = el.page_id)`,
        "edit_logs",
        "page_id",
        "wiki_pages"
      ),
      // 7. entities.relatedEntries JSONB → entities
      checkDangling(
        db,
        sql`SELECT DISTINCT elem->>'id' AS ref FROM entities ent, jsonb_array_elements(ent.related_entries) AS elem WHERE ent.related_entries IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e2 WHERE e2.id = elem->>'id')`,
        "entities",
        "related_entries[].id",
        "entities"
      ),
      // 8. resource_citations.page_id → wiki_pages
      // Catches both NULL page_id (unresolved) and non-NULL values with no matching wiki_page
      checkDangling(
        db,
        sql`SELECT DISTINCT rc.page_id::text AS ref FROM resource_citations rc WHERE rc.page_id IS NULL OR NOT EXISTS (SELECT 1 FROM wiki_pages wp WHERE wp.id = rc.page_id)`,
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

export const integrityRoute = integrityApp;
export type IntegrityRoute = typeof integrityApp;
