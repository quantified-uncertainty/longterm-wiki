/**
 * Entity Profile — aggregated view of ALL TableBase records for a single entity.
 *
 * Single endpoint that queries every relational table and returns sections
 * with rows + auto-derived schema metadata from Drizzle table objects.
 */
import { Hono } from "hono";
import { eq, or, inArray } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";
import {
  entities,
  personnel,
  grants,
  fundingRounds,
  investments,
  equityPositions,
  divisions,
  divisionPersonnel,
  fundingPrograms,
  benchmarkResults,
  facts,
  things,
  wikiPages,
  researchAreaOrganizations,
  verificationVerdicts,
  policyStakeholders,
  entityRecommendedResources,
} from "../../schema.js";
import { resolveEntityStableId } from "../shared/entity-resolution.js";
import { notFoundError } from "../shared/utils.js";
import { COLUMN_DESCRIPTIONS } from "./entity-profile-descriptions.js";
import type { PgTable } from "drizzle-orm/pg-core";

const logger = rootLogger.child({ component: "entity-profile" });

// ---- Schema introspection (cached at module level — schema is static) ----

interface ColumnMeta {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  hasDefault: boolean;
  description?: string;
}

function buildSchemaForTable(table: PgTable, tableName: string): ColumnMeta[] {
  const columns = getTableColumns(table);
  const descriptions = COLUMN_DESCRIPTIONS[tableName] ?? {};

  return Object.values(columns).map((col) => {
    // Drizzle Column objects have these properties at runtime
    const c = col as { name: string; dataType: string; columnType: string; notNull: boolean; hasDefault: boolean };
    const meta: ColumnMeta = {
      name: c.name,
      dataType: c.dataType,
      columnType: c.columnType,
      notNull: c.notNull,
      hasDefault: c.hasDefault,
    };
    if (descriptions[c.name]) {
      meta.description = descriptions[c.name];
    }
    return meta;
  });
}

// ---- Columns to exclude from output (internal/noisy) ----

const EXCLUDED_COLUMNS = new Set([
  "synced_at",
  "created_at",
  "updated_at",
  "content_plaintext",
  "search_vector",
  "synced_from_branch",
  "synced_from_commit",
]);

// Also build a camelCase version for stripping from Drizzle query results
const EXCLUDED_CAMEL = new Set(
  [...EXCLUDED_COLUMNS].map((k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))
);

function stripInternalColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!EXCLUDED_CAMEL.has(key)) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

// ---- Query safety ----

/** Hard cap on rows returned per section to prevent unbounded payloads. */
const SECTION_ROW_LIMIT = 500;

/**
 * Fetch limit used in SQL — one extra row so we can detect truncation
 * without an additional COUNT query.
 */
const FETCH_LIMIT = SECTION_ROW_LIMIT + 1;

// ---- Section definition ----

interface SectionDef {
  key: string;
  label: string;
  description: string;
  table: PgTable;
  tableName: string;
  query: (db: ReturnType<typeof getDrizzleDb>, stableId: string, slug: string) => Promise<Record<string, unknown>[]>;
}

const SECTIONS: SectionDef[] = [
  {
    key: "personnel",
    label: "Personnel",
    description: "People with roles at this entity (as org or person)",
    table: personnel,
    tableName: "personnel",
    query: (db, stableId) =>
      db.select().from(personnel).where(
        or(eq(personnel.orgEntityId, stableId), eq(personnel.personEntityId, stableId))
      ).limit(FETCH_LIMIT),
  },
  {
    key: "divisions",
    label: "Divisions",
    description: "Organizational sub-units (funds, teams, departments, labs)",
    table: divisions,
    tableName: "divisions",
    query: (db, stableId) =>
      db.select().from(divisions).where(eq(divisions.parentOrgId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "divisionPersonnel",
    label: "Division Personnel",
    description: "People assigned to divisions of this entity",
    table: divisionPersonnel,
    tableName: "division_personnel",
    query: async (db, stableId) => {
      const orgDivisions = await db.select({ id: divisions.id }).from(divisions)
        .where(eq(divisions.parentOrgId, stableId));
      if (orgDivisions.length === 0) return [];
      const divIds = orgDivisions.map((d) => d.id);
      return db.select().from(divisionPersonnel).where(
        inArray(divisionPersonnel.divisionId, divIds)
      ).limit(FETCH_LIMIT);
    },
  },
  {
    key: "grantsGiven",
    label: "Grants Given",
    description: "Grants made by this entity as grantor",
    table: grants,
    tableName: "grants",
    query: (db, stableId) =>
      db.select().from(grants).where(eq(grants.orgEntityId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "grantsReceived",
    label: "Grants Received",
    description: "Grants received by this entity as grantee",
    table: grants,
    tableName: "grants",
    query: (db, stableId) =>
      db.select().from(grants).where(eq(grants.granteeEntityId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "fundingRounds",
    label: "Funding Rounds",
    description: "Equity and strategic investment rounds",
    table: fundingRounds,
    tableName: "funding_rounds",
    query: (db, stableId) =>
      db.select().from(fundingRounds).where(eq(fundingRounds.companyEntityId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "investments",
    label: "Investments",
    description: "Investor participation in funding rounds (as company or investor)",
    table: investments,
    tableName: "investments",
    query: (db, stableId) =>
      db.select().from(investments).where(
        or(eq(investments.companyEntityId, stableId), eq(investments.investorEntityId, stableId))
      ).limit(FETCH_LIMIT),
  },
  {
    key: "equityPositions",
    label: "Equity Positions",
    description: "Current/historical equity ownership stakes (as company or holder)",
    table: equityPositions,
    tableName: "equity_positions",
    query: (db, stableId) =>
      db.select().from(equityPositions).where(
        or(eq(equityPositions.companyEntityId, stableId), eq(equityPositions.holderEntityId, stableId))
      ).limit(FETCH_LIMIT),
  },
  {
    key: "fundingPrograms",
    label: "Funding Programs",
    description: "RFPs, grant rounds, fellowships, prizes",
    table: fundingPrograms,
    tableName: "funding_programs",
    query: (db, stableId) =>
      db.select().from(fundingPrograms).where(eq(fundingPrograms.orgId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "researchAreaOrganizations",
    label: "Research Areas",
    description: "Research areas this entity is associated with",
    table: researchAreaOrganizations,
    tableName: "research_area_organizations",
    query: (db, _stableId, slug) =>
      db.select().from(researchAreaOrganizations).where(
        eq(researchAreaOrganizations.organizationId, slug)
      ).limit(FETCH_LIMIT),
  },
  {
    key: "benchmarkResults",
    label: "Benchmark Results",
    description: "AI model benchmark scores (matched by slug)",
    table: benchmarkResults,
    tableName: "benchmark_results",
    query: (db, _stableId, slug) =>
      db.select().from(benchmarkResults).where(eq(benchmarkResults.modelId, slug)).limit(FETCH_LIMIT),
  },
  {
    key: "policyStakeholders",
    label: "Policy Stakeholders",
    description: "Positions on policies (as policy or stakeholder entity)",
    table: policyStakeholders,
    tableName: "policy_stakeholders",
    query: (db, stableId) =>
      db.select().from(policyStakeholders).where(
        or(eq(policyStakeholders.policyEntityId, stableId), eq(policyStakeholders.stakeholderEntityId, stableId))
      ).limit(FETCH_LIMIT),
  },
  {
    key: "recommendedResources",
    label: "Recommended Resources",
    description: "Books, papers, videos, and other resources recommended by or for this entity",
    table: entityRecommendedResources,
    tableName: "entity_recommended_resources",
    query: (db, stableId) =>
      db.select().from(entityRecommendedResources)
        .where(eq(entityRecommendedResources.entityId, stableId))
        .orderBy(entityRecommendedResources.sortOrder)
        .limit(FETCH_LIMIT),
  },
  {
    key: "facts",
    label: "Facts",
    description: "Structured facts from FactBase (timeseries, measures)",
    table: facts,
    tableName: "facts",
    query: (db, stableId) =>
      db.select().from(facts).where(eq(facts.entityId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "things",
    label: "Things",
    description: "Cross-base unified index entries parented to this entity",
    table: things,
    tableName: "things",
    query: (db, stableId) =>
      db.select().from(things).where(eq(things.parentThingId, stableId)).limit(FETCH_LIMIT),
  },
  {
    key: "wikiPages",
    label: "Wiki Pages",
    description: "MDX wiki pages matching this entity slug",
    table: wikiPages,
    tableName: "wiki_pages",
    query: (db, _stableId, slug) =>
      db.select({
        id: wikiPages.id,
        wikiId: wikiPages.wikiId,
        slug: wikiPages.slug,
        title: wikiPages.title,
        description: wikiPages.description,
        category: wikiPages.category,
        subcategory: wikiPages.subcategory,
        entityType: wikiPages.entityType,
        quality: wikiPages.quality,
        readerImportance: wikiPages.readerImportance,
        researchImportance: wikiPages.researchImportance,
        wordCount: wikiPages.wordCount,
        lastUpdated: wikiPages.lastUpdated,
        contentFormat: wikiPages.contentFormat,
        coveragePassing: wikiPages.coveragePassing,
        coverageTotal: wikiPages.coverageTotal,
        updateFrequency: wikiPages.updateFrequency,
        daysSinceUpdate: wikiPages.daysSinceUpdate,
        staleness: wikiPages.staleness,
        readerRank: wikiPages.readerRank,
        researchRank: wikiPages.researchRank,
      }).from(wikiPages).where(eq(wikiPages.slug, slug)).limit(FETCH_LIMIT),
  },
];

// Pre-compute schema metadata per unique tableName (static, never changes at runtime)
const SCHEMA_CACHE = new Map<string, ColumnMeta[]>();
for (const section of SECTIONS) {
  if (!SCHEMA_CACHE.has(section.tableName)) {
    SCHEMA_CACHE.set(
      section.tableName,
      buildSchemaForTable(section.table, section.tableName)
        .filter((col) => !EXCLUDED_COLUMNS.has(col.name))
    );
  }
}

// Sections that have record verdicts
const VERDICT_SECTIONS = new Set([
  "personnel", "grantsGiven", "grantsReceived", "fundingRounds",
  "investments", "equityPositions", "divisions", "fundingPrograms",
]);

// ---- Route definition (method-chained for Hono RPC type inference) ----

const entityProfileApp = new Hono()

  .get("/:identifier", async (c) => {
    const identifier = c.req.param("identifier");
    const db = getDrizzleDb();

    // Resolve identifier and fetch entity row in one step
    const stableId = await resolveEntityStableId(db, identifier);
    if (!stableId) {
      return notFoundError(c, `Entity not found: ${identifier}`);
    }

    const [entityRow] = await db.select().from(entities)
      .where(eq(entities.stableId, stableId)).limit(1);

    if (!entityRow) {
      return notFoundError(c, `Entity row not found for stableId: ${stableId}`);
    }

    const slug = entityRow.id; // entity.id is the slug

    // Run all section queries in parallel
    const sectionResults = await Promise.all(
      SECTIONS.map(async (section) => {
        try {
          const rows = await section.query(db, stableId, slug);
          const truncated = rows.length > SECTION_ROW_LIMIT;
          const capped = truncated ? rows.slice(0, SECTION_ROW_LIMIT) : rows;
          return {
            key: section.key,
            label: section.label,
            description: section.description,
            schema: { columns: SCHEMA_CACHE.get(section.tableName) ?? [] },
            rows: stripInternalColumns(capped),
            total: capped.length,
            truncated,
          };
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err), section: section.key },
            `Entity profile section ${section.key} failed`
          );
          return {
            key: section.key,
            label: section.label,
            description: section.description,
            schema: { columns: [] },
            rows: [],
            total: 0,
            truncated: false,
            error: `Failed to load section "${section.key}"`,
          };
        }
      })
    );

    // Batch-fetch record verdicts for all record IDs found
    const recordIds: string[] = [];
    for (const section of sectionResults) {
      if (VERDICT_SECTIONS.has(section.key)) {
        for (const row of section.rows) {
          const id = row.id;
          if (typeof id === "string") {
            recordIds.push(id);
          }
        }
      }
    }

    let verdicts: Record<string, { verdict: string; confidence: number | null }> = {};
    if (recordIds.length > 0) {
      const verdictRows = await db.select().from(verificationVerdicts)
        .where(inArray(verificationVerdicts.recordId, recordIds));
      for (const v of verdictRows) {
        verdicts[v.recordId] = { verdict: v.verdict, confidence: v.confidence };
      }
    }

    // Batch-resolve entity reference stableIds to display names
    const entityRefIds = new Set<string>();
    for (const section of sectionResults) {
      for (const row of section.rows) {
        for (const [key, val] of Object.entries(row)) {
          const isRef =
            key.endsWith("EntityId") ||
            key.endsWith("_entity_id") ||
            key === "stableId" ||
            key === "stable_id" ||
            key === "parentOrgId" ||
            key === "parent_org_id";
          if (isRef && typeof val === "string" && val.length === 10) {
            entityRefIds.add(val);
          }
        }
      }
    }

    const displayNames: Record<string, { title: string; slug: string; entityType: string }> = {};
    if (entityRefIds.size > 0) {
      const entityRows = await db
        .select({
          stableId: entities.stableId,
          slug: entities.id,
          title: entities.title,
          entityType: entities.entityType,
        })
        .from(entities)
        .where(inArray(entities.stableId, [...entityRefIds]));
      for (const e of entityRows) {
        if (e.stableId && e.title) {
          displayNames[e.stableId] = {
            title: e.title,
            slug: e.slug,
            entityType: e.entityType ?? "",
          };
        }
      }
    }

    // Strip internal columns from entity row
    const { syncedAt, createdAt, updatedAt, ...entityData } = entityRow;

    return c.json({
      entity: entityData,
      sections: sectionResults,
      verdicts,
      displayNames,
    });
  });

// ---- Exports ----

export const entityProfileRoute = entityProfileApp;
export type EntityProfileRoute = typeof entityProfileApp;
