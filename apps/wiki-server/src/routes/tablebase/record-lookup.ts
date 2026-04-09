/**
 * Record Lookup — fetch a full source record by table name + ID.
 *
 * Used by the UI to show detail views for records referenced by the `things`
 * table (which stores sourceTable + sourceId for every indexed item).
 *
 * Security: The TABLE_MAP acts as a static whitelist, validated by Zod enum.
 * Only tables explicitly listed can be queried.
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
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
  benchmarks,
  benchmarkResults,
  publications,
  policyStakeholders,
  entityEvents,
  entityAssessments,
  researchAreaOrganizations,
  resources,
  researchAreas,
  facts,
} from "../../schema.js";
import { isAnySid } from "@longterm-wiki/id-utils";
import { notFoundError, validationError } from "../shared/utils.js";
import { stripInternalColumnsFromRow } from "../shared/strip-internal-columns.js";
import type { PgTable } from "drizzle-orm/pg-core";
import { inArray } from "drizzle-orm";

const logger = rootLogger.child({ component: "record-lookup" });

// ---- Table map: sourceTable name → Drizzle table object ----
//
// `researchAreaOrganizations` has a composite primary key (no single `id`
// column), so it's handled separately in the query logic below.

const VALID_SOURCE_TABLES = [
  "personnel",
  "grants",
  "funding_rounds",
  "investments",
  "equity_positions",
  "divisions",
  "division_personnel",
  "funding_programs",
  "benchmarks",
  "benchmark_results",
  "publications",
  "policy_stakeholders",
  "entity_events",
  "entity_assessments",
  "research_area_organizations",
  "resources",
  "research_areas",
  "facts",
  "entities",
] as const;

type SourceTableName = (typeof VALID_SOURCE_TABLES)[number];

const TABLE_MAP: Record<SourceTableName, PgTable> = {
  personnel,
  grants,
  funding_rounds: fundingRounds,
  investments,
  equity_positions: equityPositions,
  divisions,
  division_personnel: divisionPersonnel,
  funding_programs: fundingPrograms,
  benchmarks,
  benchmark_results: benchmarkResults,
  publications,
  policy_stakeholders: policyStakeholders,
  entity_events: entityEvents,
  entity_assessments: entityAssessments,
  research_area_organizations: researchAreaOrganizations,
  resources,
  research_areas: researchAreas,
  facts,
  entities,
};

const sourceTableSchema = z.enum(VALID_SOURCE_TABLES);

// ---- Route definition (method-chained for Hono RPC type inference) ----

const recordLookupApp = new Hono()

  .get("/:sourceTable/:sourceId", async (c) => {
    const rawSourceTable = c.req.param("sourceTable");
    const sourceId = c.req.param("sourceId");

    // Validate sourceTable against whitelist
    const parseResult = sourceTableSchema.safeParse(rawSourceTable);
    if (!parseResult.success) {
      return validationError(c, `Invalid source table: ${rawSourceTable.slice(0, 100)}`);
    }
    const sourceTable = parseResult.data;

    const db = getDrizzleDb();

    // Query the record
    let rows: Record<string, unknown>[];
    try {
      if (sourceTable === "research_area_organizations") {
        // Composite PK table: sourceId is "researchAreaId:organizationId"
        const parts = sourceId.split(":");
        if (parts.length !== 2) {
          return validationError(
            c,
            `research_area_organizations requires sourceId in "researchAreaId:organizationId" format, got: ${sourceId.slice(0, 100)}`
          );
        }
        rows = await db
          .select()
          .from(researchAreaOrganizations)
          .where(
            and(
              eq(researchAreaOrganizations.researchAreaId, parts[0]),
              eq(researchAreaOrganizations.organizationId, parts[1])
            )
          )
          .limit(1);
      } else if (sourceTable === "facts") {
        // Composite key: sourceId is "encodeURIComponent(entityId):encodeURIComponent(factId)"
        const colonIdx = sourceId.indexOf(":");
        if (colonIdx === -1) {
          return validationError(
            c,
            `facts requires sourceId in "entityId:factId" format, got: ${sourceId.slice(0, 100)}`
          );
        }
        let entityId: string;
        let factId: string;
        try {
          entityId = decodeURIComponent(sourceId.slice(0, colonIdx));
          factId = decodeURIComponent(sourceId.slice(colonIdx + 1));
        } catch {
          return validationError(c, `Malformed percent-encoding in facts sourceId: ${sourceId.slice(0, 100)}`);
        }
        rows = await db
          .select()
          .from(facts)
          .where(and(eq(facts.entityId, entityId), eq(facts.factId, factId)))
          .limit(1);
      } else if (sourceTable === "entities") {
        // entities.id is the slug column (not the PK which is stableId);
        // things.sourceId stores the slug, so look up by entities.id.
        rows = await db
          .select()
          .from(entities)
          .where(eq(entities.id, sourceId))
          .limit(1);
      } else {
        const table = TABLE_MAP[sourceTable];
        // All other tables have a single `id` primary key column.
        // We use (table as any).id because the table type is generic PgTable;
        // the sourceTable has already been validated via Zod enum whitelist.
        rows = await db
          .select()
          .from(table)
          .where(eq((table as any).id, sourceId)) // as-any-ok: generic PgTable type erases column types; sourceTable validated via Zod enum whitelist above
          .limit(1);
      }
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          sourceTable,
          sourceId,
        },
        "Record lookup query failed"
      );
      return c.json(
        { error: "database_error", message: "Failed to query record" },
        500
      );
    }

    if (rows.length === 0) {
      return notFoundError(c, `Record not found: ${sourceTable}/${sourceId}`);
    }

    const record = stripInternalColumnsFromRow(rows[0]);

    // Collect all stableId values from the record for entity name resolution
    const entityRefIds = new Set<string>();
    for (const value of Object.values(record)) {
      if (typeof value === "string" && isAnySid(value)) {
        entityRefIds.add(value);
      }
    }

    // Batch-resolve stableIds to display names
    const displayNames: Record<string, { title: string; slug: string; entityType: string }> = {};
    if (entityRefIds.size > 0) {
      try {
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
      } catch (err) {
        // Non-critical: log and continue without display names
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to resolve entity display names for record lookup"
        );
      }
    }

    return c.json({
      sourceTable,
      sourceId,
      record,
      displayNames,
    });
  });

// ---- Exports ----

export const recordLookupRoute = recordLookupApp;
export type RecordLookupRoute = typeof recordLookupApp;
