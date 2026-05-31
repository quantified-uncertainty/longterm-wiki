/**
 * Per-table SELECT queries for records missing a source URL.
 *
 * Each query joins to the `entities` table to surface display names, and
 * returns a uniform shape (`record_id`, `record_table`, `entity_id`,
 * `entity_name`, `description`, plus table-specific structured fields the
 * downstream backfill pipeline uses to render claims and search queries).
 */

import { isNull, or, eq, sql, count, and, notInArray, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../../db.js";
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
} from "../../../schema.js";

/** Metadata fact measures to skip — not verifiable claims. */
const SKIP_MEASURES = ["website", "description", "logo", "image"];

export type Db = ReturnType<typeof getDrizzleDb>;
export type TableResult = { total: number; records: Record<string, unknown>[] };
export type TableQueryFn = (db: Db, cap: number, retryAfterDays: number) => Promise<TableResult>;

/**
 * WHERE fragment that excludes records attempted within the last
 * `retryAfterDays` days, per the `sourcing_attempts` ledger (QUA-1071).
 *
 * `tableName` is the ledger's `table_name` value (e.g. `'facts'`) and
 * `recordIdText` is the record's id rendered as text — both numeric-id and
 * varchar-id tables store their id as text in the ledger. Returns `undefined`
 * when `retryAfterDays <= 0` so callers can opt out (no filtering, the legacy
 * behaviour) by passing 0; `and()` drops the `undefined`.
 */
function notRecentlyAttempted(
  tableName: string,
  recordIdText: SQL<string>,
  retryAfterDays: number,
): SQL | undefined {
  if (retryAfterDays <= 0) return undefined;
  return sql`NOT EXISTS (
    SELECT 1 FROM sourcing_attempts sa
    WHERE sa.table_name = ${tableName}
      AND sa.record_id = ${recordIdText}
      AND sa.last_attempt_at > now() - make_interval(days => ${retryAfterDays})
  )`;
}

async function queryFacts(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const factsEntity = alias(entities, "facts_entity");
  const whereClause = and(
    or(isNull(facts.source), eq(facts.source, "")),
    or(isNull(facts.measure), notInArray(facts.measure, SKIP_MEASURES)),
    nameIsUsable(factsEntity.title, facts.entityId),
    notRecentlyAttempted("facts", sql<string>`${facts.id}::text`, retryAfterDays),
  );

  const rows = await db
    .select({
      record_id: sql<string>`${facts.id}::text`.as("record_id"),
      record_table: sql<string>`'facts'`.as("record_table"),
      entity_id: facts.entityId,
      entity_name: sql<string>`COALESCE(${factsEntity.title}, ${facts.entityId})`.as("entity_name"),
      description: sql<string>`COALESCE(${factsEntity.title}, ${facts.entityId}) || ': ' || COALESCE(${facts.label}, '') || CASE WHEN ${facts.value} IS NOT NULL THEN ' = ' || LEFT(${facts.value}, 200) ELSE '' END`.as("description"),
      label: facts.label,
      value: facts.value,
      measure: facts.measure,
      fact_id: facts.factId,
    })
    .from(facts)
    .leftJoin(factsEntity, eq(factsEntity.stableId, facts.entityId))
    .where(whereClause)
    .limit(cap);

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(facts)
    .leftJoin(factsEntity, eq(factsEntity.stableId, facts.entityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPersonnel(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const personE = alias(entities, "person_e");
  const orgE = alias(entities, "org_e");
  const whereClause = and(
    or(isNull(personnel.source), eq(personnel.source, "")),
    nameIsUsable(personE.title, personnel.personId),
    nameIsUsable(orgE.title, personnel.organizationId),
    notRecentlyAttempted("personnel", sql<string>`${personnel.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(personnel)
    .leftJoin(personE, eq(personE.stableId, personnel.personEntityId))
    .leftJoin(orgE, eq(orgE.stableId, personnel.orgEntityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

/**
 * SQL fragment: the resolved display value for an entity reference,
 * with `sid_*` machine-ID leaks and empty strings nulled out.
 *
 * Used in WHERE clauses to skip rows whose displayed name would be
 * garbage (a `sid_*` token leaking from a malformed FK fallback, or
 * an empty raw column). See QUA-764 for the data-side cleanup ticket.
 */
function resolvedName(joinedTitle: AnyColumn, rawFallback: AnyColumn) {
  return sql<string>`NULLIF(COALESCE(${joinedTitle}, NULLIF(${rawFallback}, '')), '')`;
}

function nameIsUsable(joinedTitle: AnyColumn, rawFallback: AnyColumn) {
  return sql<boolean>`${resolvedName(joinedTitle, rawFallback)} IS NOT NULL AND ${resolvedName(joinedTitle, rawFallback)} NOT LIKE 'sid\\_%' ESCAPE '\\'`;
}

async function queryInvestments(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const invE = alias(entities, "inv_e");
  const compE = alias(entities, "comp_e");
  // Skip rows whose company display name would be a `sid_*` machine-ID
  // leak — the claim/search-query is useless and we'd burn API spend on
  // garbage. Rows with a valid human-readable fallback (e.g. companyId
  // = 'algolia') still flow through. See QUA-764.
  const whereClause = and(
    or(isNull(investments.source), eq(investments.source, "")),
    nameIsUsable(compE.title, investments.companyId),
    notRecentlyAttempted("investments", sql<string>`${investments.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(investments)
    .leftJoin(compE, eq(compE.stableId, investments.companyEntityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPolicyStakeholders(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const stakE = alias(entities, "stak_e");
  const polE = alias(entities, "pol_e");
  // Stakeholder side: rows can fall back to `stakeholderDisplayName` when
  // the entity-FK fails, so the usability check covers both options.
  const whereClause = and(
    or(isNull(policyStakeholders.source), eq(policyStakeholders.source, "")),
    nameIsUsable(stakE.title, policyStakeholders.stakeholderDisplayName),
    nameIsUsable(polE.title, policyStakeholders.policyEntityId),
    notRecentlyAttempted("policy_stakeholders", sql<string>`${policyStakeholders.id}::text`, retryAfterDays),
  );

  const rows = await db
    .select({
      record_id: policyStakeholders.id,
      record_table: sql<string>`'policy_stakeholders'`,
      entity_id: sql<string>`COALESCE(${policyStakeholders.stakeholderEntityId}, ${policyStakeholders.policyEntityId})`,
      entity_name: sql<string>`COALESCE(${stakE.title}, ${policyStakeholders.stakeholderDisplayName})`,
      description: sql<string>`COALESCE(${stakE.title}, ${policyStakeholders.stakeholderDisplayName}, 'unknown') || ' (' || COALESCE(${policyStakeholders.position}, '') || ') on ' || COALESCE(${polE.title}, ${policyStakeholders.policyEntityId}, 'unknown policy')`,
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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(policyStakeholders)
    .leftJoin(stakE, eq(stakE.stableId, policyStakeholders.stakeholderEntityId))
    .leftJoin(polE, eq(polE.stableId, policyStakeholders.policyEntityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryEquityPositions(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const holdE = alias(entities, "hold_e");
  const compE = alias(entities, "comp_e2");
  const whereClause = and(
    or(isNull(equityPositions.source), eq(equityPositions.source, "")),
    nameIsUsable(holdE.title, equityPositions.holderId),
    nameIsUsable(compE.title, equityPositions.companyId),
    notRecentlyAttempted("equity_positions", sql<string>`${equityPositions.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(equityPositions)
    .leftJoin(holdE, eq(holdE.stableId, equityPositions.holderEntityId))
    .leftJoin(compE, eq(compE.stableId, equityPositions.companyEntityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryDivisions(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const orgE = alias(entities, "div_org_e");
  const whereClause = and(
    or(isNull(divisions.source), eq(divisions.source, "")),
    nameIsUsable(orgE.title, divisions.parentOrgId),
    notRecentlyAttempted("divisions", sql<string>`${divisions.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(divisions)
    .leftJoin(orgE, eq(orgE.stableId, divisions.parentOrgId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryFundingRounds(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const compE = alias(entities, "fr_comp_e");
  const whereClause = and(
    or(isNull(fundingRounds.source), eq(fundingRounds.source, "")),
    nameIsUsable(compE.title, fundingRounds.companyId),
    notRecentlyAttempted("funding_rounds", sql<string>`${fundingRounds.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(fundingRounds)
    .leftJoin(compE, eq(compE.stableId, fundingRounds.companyEntityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryFundingPrograms(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const orgE = alias(entities, "fp_org_e");
  const whereClause = and(
    or(isNull(fundingPrograms.source), eq(fundingPrograms.source, "")),
    nameIsUsable(orgE.title, fundingPrograms.orgId),
    notRecentlyAttempted("funding_programs", sql<string>`${fundingPrograms.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(fundingPrograms)
    .leftJoin(orgE, eq(orgE.stableId, fundingPrograms.orgId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPublications(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const pubE = alias(entities, "pub_e");
  const whereClause = and(
    or(isNull(publications.url), eq(publications.url, "")),
    nameIsUsable(pubE.title, publications.entityId),
    notRecentlyAttempted("publications", sql<string>`${publications.id}::text`, retryAfterDays),
  );

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

  const [{ cnt }] = await db
    .select({ cnt: count() })
    .from(publications)
    .leftJoin(pubE, eq(pubE.stableId, publications.entityId))
    .where(whereClause);
  return { total: cnt, records: rows };
}

async function queryPageCitations(db: Db, cap: number, retryAfterDays: number): Promise<TableResult> {
  const whereClause = and(
    or(isNull(pageCitations.url), eq(pageCitations.url, "")),
    notRecentlyAttempted("page_citations", sql<string>`${pageCitations.id}::text`, retryAfterDays),
  );

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

export const TABLE_QUERIES: Record<string, TableQueryFn> = {
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

export async function safeQuery(name: string, fn: () => Promise<TableResult>): Promise<TableResult> {
  try {
    return await fn();
  } catch (e: unknown) {
    console.warn(`[missing-sources] Error querying ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return { total: 0, records: [] };
  }
}
