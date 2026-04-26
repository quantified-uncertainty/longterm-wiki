/**
 * Missing Sources — returns records across tables where source IS NULL,
 * and a companion endpoint to update the source URL for a single record.
 *
 * Used by `crux tb backfill-sources` to get the work queue for source URL
 * discovery and to write back a discovered URL without touching other columns.
 *
 * GET  /              — All records missing sources, grouped by table
 * POST /update-source — Update source/url column for a single record
 */

import { Hono } from "hono";
import { z } from "zod";
import { isNull, or, eq, sql, count, and, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import {
  facts,
  personnel,
  investments,
  equityPositions,
  policyStakeholders,
  divisions,
  fundingRounds,
  fundingPrograms,
  publications,
  pageCitations,
  entities,
} from "../../schema.js";
import { zv } from "../shared/utils.js";

const MissingSourcesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  table: z.string().max(50).optional(),
});

/** Metadata fact measures to skip — not verifiable claims. */
const SKIP_MEASURES = ["website", "description", "logo", "image"];

type Db = ReturnType<typeof getDrizzleDb>;
type TableResult = { total: number; records: Record<string, unknown>[] };
type TableQueryFn = (db: Db, cap: number) => Promise<TableResult>;

async function queryFacts(db: Db, cap: number): Promise<TableResult> {
  const factsEntity = alias(entities, "facts_entity");
  const whereClause = and(
    or(isNull(facts.source), eq(facts.source, "")),
    or(isNull(facts.measure), notInArray(facts.measure, SKIP_MEASURES)),
  );

  const rows = await db
    .select({
      record_id: sql<string>`${facts.id}::text`.as("record_id"),
      record_table: sql<string>`'facts'`.as("record_table"),
      entity_id: facts.entityId,
      entity_name: sql<string>`COALESCE(${factsEntity.title}, ${facts.entityId})`.as("entity_name"),
      description: sql<string>`COALESCE(${facts.label}, '') || CASE WHEN ${facts.value} IS NOT NULL THEN ' = ' || LEFT(${facts.value}, 200) ELSE '' END`.as("description"),
      label: facts.label,
      value: facts.value,
      measure: facts.measure,
      fact_id: facts.factId,
    })
    .from(facts)
    .leftJoin(factsEntity, eq(factsEntity.stableId, facts.entityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(facts).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPersonnel(db: Db, cap: number): Promise<TableResult> {
  const personE = alias(entities, "person_e");
  const orgE = alias(entities, "org_e");
  const whereClause = or(isNull(personnel.source), eq(personnel.source, ""));

  const rows = await db
    .select({
      record_id: personnel.id,
      record_table: sql<string>`'personnel'`.as("record_table"),
      entity_id: sql<string>`COALESCE(${personnel.orgEntityId}, ${personnel.personEntityId})`.as("entity_id"),
      entity_name: sql<string>`COALESCE(${orgE.title}, ${personnel.organizationId})`.as("entity_name"),
      description: sql<string>`COALESCE(${personE.title}, ${personnel.personId}) || ' at ' || COALESCE(${orgE.title}, ${personnel.organizationId}) || ' (' || COALESCE(${personnel.role}, '') || ')'`.as("description"),
      person_name: sql<string>`COALESCE(${personE.title}, ${personnel.personId})`.as("person_name"),
      org_name: sql<string>`COALESCE(${orgE.title}, ${personnel.organizationId})`.as("org_name"),
      role: personnel.role,
    })
    .from(personnel)
    .leftJoin(personE, eq(personE.stableId, personnel.personEntityId))
    .leftJoin(orgE, eq(orgE.stableId, personnel.orgEntityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(personnel).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryInvestments(db: Db, cap: number): Promise<TableResult> {
  const invE = alias(entities, "inv_e");
  const compE = alias(entities, "comp_e");
  const whereClause = or(isNull(investments.source), eq(investments.source, ""));

  const rows = await db
    .select({
      record_id: investments.id,
      record_table: sql<string>`'investments'`.as("record_table"),
      entity_id: sql<string>`COALESCE(${investments.investorEntityId}, ${investments.companyEntityId})`.as("entity_id"),
      entity_name: sql<string>`COALESCE(${invE.title}, ${investments.investorId})`.as("entity_name"),
      description: sql<string>`COALESCE(${invE.title}, ${investments.investorId}) || ' -> ' || COALESCE(${compE.title}, ${investments.companyId})`.as("description"),
      investor_name: sql<string>`COALESCE(${invE.title}, ${investments.investorId})`.as("investor_name"),
      company_name: sql<string>`COALESCE(${compE.title}, ${investments.companyId})`.as("company_name"),
      round_name: investments.roundName,
    })
    .from(investments)
    .leftJoin(invE, eq(invE.stableId, investments.investorEntityId))
    .leftJoin(compE, eq(compE.stableId, investments.companyEntityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(investments).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPolicyStakeholders(db: Db, cap: number): Promise<TableResult> {
  const stakE = alias(entities, "stak_e");
  const polE = alias(entities, "pol_e");
  const whereClause = or(isNull(policyStakeholders.source), eq(policyStakeholders.source, ""));

  const rows = await db
    .select({
      record_id: policyStakeholders.id,
      record_table: sql<string>`'policy_stakeholders'`,
      entity_id: sql<string>`COALESCE(${policyStakeholders.stakeholderEntityId}, ${policyStakeholders.policyEntityId})`,
      entity_name: sql<string>`COALESCE(${stakE.title}, ${policyStakeholders.stakeholderDisplayName})`,
      description: sql<string>`COALESCE(${policyStakeholders.stakeholderDisplayName}, ${stakE.title}, 'unknown') || ' (' || COALESCE(${policyStakeholders.position}, '') || ') on ' || COALESCE(${polE.title}, ${policyStakeholders.policyEntityId}, 'unknown policy')`,
      stakeholder_display_name: policyStakeholders.stakeholderDisplayName,
      position: policyStakeholders.position,
      policy_entity_id: policyStakeholders.policyEntityId,
      policy_name: sql<string>`COALESCE(${polE.title}, ${policyStakeholders.policyEntityId})`.as("policy_name"),
    })
    .from(policyStakeholders)
    .leftJoin(stakE, eq(stakE.stableId, policyStakeholders.stakeholderEntityId))
    .leftJoin(polE, eq(polE.stableId, policyStakeholders.policyEntityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(policyStakeholders).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryEquityPositions(db: Db, cap: number): Promise<TableResult> {
  const holdE = alias(entities, "hold_e");
  const compE = alias(entities, "comp_e2");
  const whereClause = or(isNull(equityPositions.source), eq(equityPositions.source, ""));

  const rows = await db
    .select({
      record_id: equityPositions.id,
      record_table: sql<string>`'equity_positions'`,
      entity_id: equityPositions.companyEntityId,
      entity_name: sql<string>`COALESCE(${compE.title}, ${equityPositions.companyId})`,
      description: sql<string>`COALESCE(${holdE.title}, ${equityPositions.holderId}) || ' in ' || COALESCE(${compE.title}, ${equityPositions.companyId})`,
      holder_name: sql<string>`COALESCE(${holdE.title}, ${equityPositions.holderId})`,
      company_name: sql<string>`COALESCE(${compE.title}, ${equityPositions.companyId})`,
    })
    .from(equityPositions)
    .leftJoin(holdE, eq(holdE.stableId, equityPositions.holderEntityId))
    .leftJoin(compE, eq(compE.stableId, equityPositions.companyEntityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(equityPositions).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryDivisions(db: Db, cap: number): Promise<TableResult> {
  const orgE = alias(entities, "div_org_e");
  const whereClause = or(isNull(divisions.source), eq(divisions.source, ""));

  const rows = await db
    .select({
      record_id: divisions.id,
      record_table: sql<string>`'divisions'`,
      entity_id: divisions.parentOrgId,
      entity_name: sql<string>`COALESCE(${orgE.title}, ${divisions.parentOrgId})`,
      description: divisions.name,
      name: divisions.name,
    })
    .from(divisions)
    .leftJoin(orgE, eq(orgE.stableId, divisions.parentOrgId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(divisions).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryFundingRounds(db: Db, cap: number): Promise<TableResult> {
  const compE = alias(entities, "fr_comp_e");
  const whereClause = or(isNull(fundingRounds.source), eq(fundingRounds.source, ""));

  const rows = await db
    .select({
      record_id: fundingRounds.id,
      record_table: sql<string>`'funding_rounds'`,
      entity_id: fundingRounds.companyEntityId,
      entity_name: sql<string>`COALESCE(${compE.title}, ${fundingRounds.companyId})`,
      description: sql<string>`COALESCE(${fundingRounds.name}, '') || ' (' || COALESCE(${compE.title}, ${fundingRounds.companyId}) || ')'`,
      name: fundingRounds.name,
      company_name: sql<string>`COALESCE(${compE.title}, ${fundingRounds.companyId})`,
    })
    .from(fundingRounds)
    .leftJoin(compE, eq(compE.stableId, fundingRounds.companyEntityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(fundingRounds).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryFundingPrograms(db: Db, cap: number): Promise<TableResult> {
  const orgE = alias(entities, "fp_org_e");
  const whereClause = or(isNull(fundingPrograms.source), eq(fundingPrograms.source, ""));

  const rows = await db
    .select({
      record_id: fundingPrograms.id,
      record_table: sql<string>`'funding_programs'`,
      entity_id: fundingPrograms.orgId,
      entity_name: sql<string>`COALESCE(${orgE.title}, ${fundingPrograms.orgId})`,
      description: fundingPrograms.name,
      name: fundingPrograms.name,
    })
    .from(fundingPrograms)
    .leftJoin(orgE, eq(orgE.stableId, fundingPrograms.orgId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(fundingPrograms).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPublications(db: Db, cap: number): Promise<TableResult> {
  const pubE = alias(entities, "pub_e");
  const whereClause = or(isNull(publications.url), eq(publications.url, ""));

  const rows = await db
    .select({
      record_id: publications.id,
      record_table: sql<string>`'publications'`,
      entity_id: publications.entityId,
      entity_name: sql<string>`COALESCE(${pubE.title}, ${publications.entityId})`,
      description: publications.title,
      title: publications.title,
      authors: publications.authors,
    })
    .from(publications)
    .leftJoin(pubE, eq(pubE.stableId, publications.entityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(publications).where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPageCitations(db: Db, cap: number): Promise<TableResult> {
  const whereClause = or(isNull(pageCitations.url), eq(pageCitations.url, ""));

  const rows = await db
    .select({
      record_id: sql<string>`${pageCitations.id}::text`,
      record_table: sql<string>`'page_citations'`,
      entity_id: sql<string>`NULL`,
      entity_name: sql<string>`'Page #' || ${pageCitations.pageId}::text`,
      description: sql<string>`COALESCE(${pageCitations.title}, ${pageCitations.note}, '')`,
      cit_title: pageCitations.title,
      note: pageCitations.note,
      page_id: pageCitations.pageId,
    })
    .from(pageCitations)
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db.select({ cnt: count() }).from(pageCitations).where(whereClause);
  return { total: cnt, records: rows };
}

const TABLE_QUERIES: Record<string, TableQueryFn> = {
  facts: queryFacts,
  personnel: queryPersonnel,
  investments: queryInvestments,
  policy_stakeholders: queryPolicyStakeholders,
  equity_positions: queryEquityPositions,
  divisions: queryDivisions,
  funding_rounds: queryFundingRounds,
  funding_programs: queryFundingPrograms,
  publications: queryPublications,
  page_citations: queryPageCitations,
};

async function safeQuery(name: string, fn: () => Promise<TableResult>): Promise<TableResult> {
  try {
    return await fn();
  } catch (e: unknown) {
    console.warn(`[missing-sources] Error querying ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return { total: 0, records: [] };
  }
}

// ---------------------------------------------------------------------------
// update-source — write back a discovered URL to exactly one record
//
// This endpoint exists because the regular /sync endpoints validate the full
// record shape (Zod min(1) on required fields) and use `excluded.*` on
// conflict — both of which make partial updates impossible without data loss.
// This endpoint touches exactly one column per table and nothing else.
// ---------------------------------------------------------------------------

/**
 * Per-table spec: which column stores the source URL, and how to update it by
 * its primary key. Kept as an explicit switch (rather than dynamic Drizzle
 * building) so the types stay narrow and the set of writable tables stays
 * closed — this endpoint is a deliberate write surface and should not grow
 * implicitly when new tables are added.
 */
type UpdateFn = (db: Db, recordId: string, url: string) => Promise<number>;

const UPDATE_TABLE_KEYS = [
  "facts",
  "personnel",
  "investments",
  "policy_stakeholders",
  "equity_positions",
  "divisions",
  "funding_rounds",
  "funding_programs",
  "publications",
  "page_citations",
] as const;

async function updateRows(
  fn: () => Promise<{ rowCount?: number } | unknown[]>,
): Promise<number> {
  const res = (await fn()) as { rowCount?: number | null } | unknown[];
  if (Array.isArray(res)) return res.length;
  return res.rowCount ?? 0;
}

const UPDATE_BY_TABLE: Record<(typeof UPDATE_TABLE_KEYS)[number], UpdateFn> = {
  facts: (db, id, url) =>
    updateRows(() =>
      db
        .update(facts)
        .set({ source: url })
        .where(eq(facts.id, Number(id)))
        .returning({ id: facts.id }),
    ),
  personnel: (db, id, url) =>
    updateRows(() =>
      db
        .update(personnel)
        .set({ source: url })
        .where(eq(personnel.id, id))
        .returning({ id: personnel.id }),
    ),
  investments: (db, id, url) =>
    updateRows(() =>
      db
        .update(investments)
        .set({ source: url })
        .where(eq(investments.id, id))
        .returning({ id: investments.id }),
    ),
  policy_stakeholders: (db, id, url) =>
    updateRows(() =>
      db
        .update(policyStakeholders)
        .set({ source: url })
        .where(eq(policyStakeholders.id, id))
        .returning({ id: policyStakeholders.id }),
    ),
  equity_positions: (db, id, url) =>
    updateRows(() =>
      db
        .update(equityPositions)
        .set({ source: url })
        .where(eq(equityPositions.id, id))
        .returning({ id: equityPositions.id }),
    ),
  divisions: (db, id, url) =>
    updateRows(() =>
      db
        .update(divisions)
        .set({ source: url })
        .where(eq(divisions.id, id))
        .returning({ id: divisions.id }),
    ),
  funding_rounds: (db, id, url) =>
    updateRows(() =>
      db
        .update(fundingRounds)
        .set({ source: url })
        .where(eq(fundingRounds.id, id))
        .returning({ id: fundingRounds.id }),
    ),
  funding_programs: (db, id, url) =>
    updateRows(() =>
      db
        .update(fundingPrograms)
        .set({ source: url })
        .where(eq(fundingPrograms.id, id))
        .returning({ id: fundingPrograms.id }),
    ),
  // publications + page_citations store the source URL in the `url` column,
  // not `source`. Writing to `source` would leave `url` NULL so the record
  // keeps showing up as "missing source" on every backfill run.
  publications: (db, id, url) =>
    updateRows(() =>
      db
        .update(publications)
        .set({ url })
        .where(eq(publications.id, id))
        .returning({ id: publications.id }),
    ),
  page_citations: (db, id, url) =>
    updateRows(() =>
      db
        .update(pageCitations)
        .set({ url })
        .where(eq(pageCitations.id, Number(id)))
        .returning({ id: pageCitations.id }),
    ),
};

const UpdateSourceBody = z.object({
  table: z.enum(UPDATE_TABLE_KEYS),
  recordId: z.string().min(1).max(100),
  url: z.string().url().max(2000),
});

const missingSourcesApp = new Hono()
  .get("/", zv("query", MissingSourcesQuery), async (c) => {
    const { limit, table: tableFilter } = c.req.valid("query");
    const db = getDrizzleDb();
    const cap = Math.min(limit, 2000);

    const tables: Record<string, TableResult> = {};
    let totalMissing = 0;

    for (const [name, query] of Object.entries(TABLE_QUERIES)) {
      if (tableFilter && tableFilter !== name) continue;
      const result = await safeQuery(name, () => query(db, cap));
      tables[name] = result;
      totalMissing += result.total;
    }

    return c.json({ tables, totalMissing });
  })
  .post("/update-source", zv("json", UpdateSourceBody), async (c) => {
    const { table, recordId, url } = c.req.valid("json");
    const db = getDrizzleDb();

    // Numeric-ID tables reject non-numeric recordIds before we hit the query,
    // otherwise Number("abc") → NaN silently matches nothing.
    if ((table === "facts" || table === "page_citations") && !/^\d+$/.test(recordId)) {
      return c.json({ updated: 0, error: "recordId must be numeric for this table" }, 400);
    }

    try {
      const updated = await UPDATE_BY_TABLE[table](db, recordId, url);
      return c.json({ updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[update-source] ${table}/${recordId}: ${msg}`);
      return c.json({ updated: 0, error: msg }, 500);
    }
  });

export const missingSourcesRoute = missingSourcesApp;
export type MissingSourcesRoute = typeof missingSourcesApp;
