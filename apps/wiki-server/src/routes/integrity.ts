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

// ---- Types ----

interface ClaimsAuditCheck {
  name: string;
  description: string;
  status: "pass" | "warn" | "fail";
  count: number;
  details?: string;
  sample?: Array<Record<string, unknown>>;
}

interface ClaimsAuditResult {
  status: "clean" | "issues_found";
  checked_at: string;
  checks: ClaimsAuditCheck[];
  summary: {
    total_claims: number;
    total_sources: number;
    checks_run: number;
    passed: number;
    warnings: number;
    failures: number;
  };
}

// ---- GET /claims-audit ----

integrityRoute.get("/claims-audit", async (c) => {
  const db = getDrizzleDb();
  const checks: ClaimsAuditCheck[] = [];

  // 1. Check claim_mode NOT NULL constraint (migration 0030 added DEFAULT 'endorsed')
  const nullClaimMode = (await db.execute(
    sql`SELECT COUNT(*) AS cnt FROM claims WHERE claim_mode IS NULL`
  )) as Array<{ cnt: string }>;
  const nullModeCount = parseInt(nullClaimMode[0]?.cnt ?? "0", 10);
  checks.push({
    name: "claim_mode_not_null",
    description: "All claims have a non-null claim_mode (endorsed or attributed)",
    status: nullModeCount === 0 ? "pass" : "fail",
    count: nullModeCount,
    ...(nullModeCount > 0 && {
      details: `${nullModeCount} claims have NULL claim_mode — migration 0030 should have set DEFAULT 'endorsed'`,
    }),
  });

  // 2. Check claim_mode values are valid
  const invalidClaimMode = (await db.execute(
    sql`SELECT DISTINCT claim_mode AS val, COUNT(*) AS cnt FROM claims WHERE claim_mode NOT IN ('endorsed', 'attributed') GROUP BY claim_mode`
  )) as Array<{ val: string; cnt: string }>;
  const invalidModeCount = invalidClaimMode.reduce(
    (sum, r) => sum + parseInt(r.cnt, 10),
    0
  );
  checks.push({
    name: "claim_mode_valid_values",
    description: "All claim_mode values are 'endorsed' or 'attributed'",
    status: invalidModeCount === 0 ? "pass" : "fail",
    count: invalidModeCount,
    ...(invalidModeCount > 0 && {
      sample: invalidClaimMode.map((r) => ({ value: r.val, count: r.cnt })),
    }),
  });

  // 3. Check is_primary in claim_sources (migration 0029 off-by-one bug)
  // Each claim with sources should have exactly one primary source
  const claimsWithoutPrimary = (await db.execute(
    sql`SELECT cs.claim_id, COUNT(*) AS source_count
        FROM claim_sources cs
        GROUP BY cs.claim_id
        HAVING COUNT(*) > 0 AND SUM(CASE WHEN cs.is_primary THEN 1 ELSE 0 END) = 0`
  )) as Array<{ claim_id: string; source_count: string }>;
  checks.push({
    name: "claim_sources_has_primary",
    description: "Every claim with sources has at least one marked is_primary=true",
    status: claimsWithoutPrimary.length === 0 ? "pass" : "warn",
    count: claimsWithoutPrimary.length,
    ...(claimsWithoutPrimary.length > 0 && {
      details: `${claimsWithoutPrimary.length} claims have sources but none marked as primary`,
      sample: claimsWithoutPrimary.slice(0, 10).map((r) => ({
        claimId: r.claim_id,
        sourceCount: r.source_count,
      })),
    }),
  });

  // 4. Check for self-referential relatedEntities
  const selfRefs = (await db.execute(
    sql`SELECT id, entity_id FROM claims
        WHERE related_entities IS NOT NULL
        AND related_entities::text != 'null'
        AND related_entities::text != '[]'
        AND related_entities @> to_jsonb(entity_id)`
  )) as Array<{ id: string; entity_id: string }>;
  checks.push({
    name: "no_self_referential_related_entities",
    description: "No claims have their own entityId in relatedEntities",
    status: selfRefs.length === 0 ? "pass" : "warn",
    count: selfRefs.length,
    ...(selfRefs.length > 0 && {
      details: `${selfRefs.length} claims reference themselves in relatedEntities`,
      sample: selfRefs.slice(0, 10).map((r) => ({
        claimId: r.id,
        entityId: r.entity_id,
      })),
    }),
  });

  // 5. Check for capitalization inconsistencies in entity_id
  const capsIssues = (await db.execute(
    sql`SELECT entity_id, COUNT(*) AS cnt FROM claims
        WHERE entity_id != LOWER(entity_id)
        GROUP BY entity_id`
  )) as Array<{ entity_id: string; cnt: string }>;
  const capsCount = capsIssues.reduce(
    (sum, r) => sum + parseInt(r.cnt, 10),
    0
  );
  checks.push({
    name: "entity_id_lowercase",
    description: "All entity_id values are lowercase (no capitalization variants)",
    status: capsCount === 0 ? "pass" : "warn",
    count: capsCount,
    ...(capsCount > 0 && {
      details: `${capsCount} claims have non-lowercase entity_id`,
      sample: capsIssues.slice(0, 10).map((r) => ({
        entityId: r.entity_id,
        count: r.cnt,
      })),
    }),
  });

  // 6. Check for orphaned claim_sources (claim_id references deleted claims)
  const orphanedSources = (await db.execute(
    sql`SELECT cs.id, cs.claim_id FROM claim_sources cs
        LEFT JOIN claims c ON cs.claim_id = c.id
        WHERE c.id IS NULL`
  )) as Array<{ id: string; claim_id: string }>;
  checks.push({
    name: "no_orphaned_claim_sources",
    description: "All claim_sources reference existing claims (FK cascade should prevent this)",
    status: orphanedSources.length === 0 ? "pass" : "fail",
    count: orphanedSources.length,
    ...(orphanedSources.length > 0 && {
      sample: orphanedSources.slice(0, 10).map((r) => ({
        sourceId: r.id,
        claimId: r.claim_id,
      })),
    }),
  });

  // 7. Check numeric precision — values that lost precision from REAL→DOUBLE migration
  // REAL has ~7 decimal digits; values like 7,300,000,000 would be stored as 7,299,999,744
  const precisionIssues = (await db.execute(
    sql`SELECT id, entity_id, value_numeric FROM claims
        WHERE value_numeric IS NOT NULL
        AND ABS(value_numeric) > 1000000
        AND value_numeric != ROUND(value_numeric::numeric, 0)
        AND ABS(value_numeric - ROUND(value_numeric::numeric, 0)) > 1`
  )) as Array<{ id: string; entity_id: string; value_numeric: string }>;
  checks.push({
    name: "numeric_precision_clean",
    description: "Large numeric values don't show REAL→DOUBLE precision artifacts (fractional cents on billions)",
    status: precisionIssues.length === 0 ? "pass" : "warn",
    count: precisionIssues.length,
    ...(precisionIssues.length > 0 && {
      details: `${precisionIssues.length} claims have numeric values with possible precision loss from old REAL storage`,
      sample: precisionIssues.slice(0, 10).map((r) => ({
        claimId: r.id,
        entityId: r.entity_id,
        valueNumeric: r.value_numeric,
      })),
    }),
  });

  // 8. Check for empty claim_text
  const emptyText = (await db.execute(
    sql`SELECT COUNT(*) AS cnt FROM claims WHERE TRIM(claim_text) = '' OR claim_text IS NULL`
  )) as Array<{ cnt: string }>;
  const emptyTextCount = parseInt(emptyText[0]?.cnt ?? "0", 10);
  checks.push({
    name: "no_empty_claim_text",
    description: "All claims have non-empty claim_text",
    status: emptyTextCount === 0 ? "pass" : "fail",
    count: emptyTextCount,
  });

  // 9. Check for duplicate claims (same entity_id + claim_text)
  const duplicates = (await db.execute(
    sql`SELECT entity_id, claim_text, COUNT(*) AS cnt
        FROM claims
        GROUP BY entity_id, claim_text
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20`
  )) as Array<{ entity_id: string; claim_text: string; cnt: string }>;
  const dupCount = duplicates.reduce(
    (sum, r) => sum + parseInt(r.cnt, 10) - 1,
    0
  );
  checks.push({
    name: "no_exact_duplicate_claims",
    description: "No exact duplicate claims (same entity_id + claim_text)",
    status: dupCount === 0 ? "pass" : "warn",
    count: dupCount,
    ...(dupCount > 0 && {
      details: `${dupCount} duplicate claim rows found across ${duplicates.length} unique texts`,
      sample: duplicates.slice(0, 5).map((r) => ({
        entityId: r.entity_id,
        claimText:
          r.claim_text.length > 80
            ? r.claim_text.slice(0, 80) + "..."
            : r.claim_text,
        count: r.cnt,
      })),
    }),
  });

  // 10. Summary statistics
  const totals = (await db.execute(
    sql`SELECT
          (SELECT COUNT(*) FROM claims) AS total_claims,
          (SELECT COUNT(*) FROM claim_sources) AS total_sources`
  )) as Array<{ total_claims: string; total_sources: string }>;
  const totalClaims = parseInt(totals[0]?.total_claims ?? "0", 10);
  const totalSources = parseInt(totals[0]?.total_sources ?? "0", 10);

  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failures = checks.filter((c) => c.status === "fail").length;

  const result: ClaimsAuditResult = {
    status: failures === 0 && warnings === 0 ? "clean" : "issues_found",
    checked_at: new Date().toISOString(),
    checks,
    summary: {
      total_claims: totalClaims,
      total_sources: totalSources,
      checks_run: checks.length,
      passed,
      warnings,
      failures,
    },
  };

  return c.json(result);
});

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
