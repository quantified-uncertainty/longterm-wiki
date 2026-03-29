/**
 * Centralized entity FK resolution for sync endpoints.
 *
 * After upserting records, sync handlers call `resolveEntityFKs()` to:
 * 1. Resolve raw ID columns (slug or stableId) to entity stableIds
 * 2. Backfill display names when FK resolution fails (using the raw ID as fallback)
 *
 * This replaces the inline SQL UPDATEs previously scattered across personnel.ts
 * and adds consistent FK resolution to grants, funding-rounds, investments, and
 * equity-positions.
 */

import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import { logger } from "../../logger.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export interface FKFieldMapping {
  /** Column holding the raw identifier (slug or stableId), e.g. 'person_id' */
  rawIdColumn: string;
  /** Column to populate with the resolved entity stableId, e.g. 'person_entity_id' */
  entityIdColumn: string;
  /** Optional column for human-readable display name fallback, e.g. 'person_display_name' */
  displayNameColumn?: string;
  /** Optional entity type filter to disambiguate, e.g. 'person' */
  entityTypeFilter?: string;
}

export interface ResolveEntityFKsOptions {
  /** Target table name (snake_case), e.g. 'personnel' */
  tableName: string;
  /** FK field mappings to resolve */
  fields: FKFieldMapping[];
  /** Only resolve these record IDs (for incremental sync). When empty/undefined, resolves all. */
  scopeIds?: string[];
}

export interface ResolutionStats {
  resolved: number;
  backfilled: number;
}

/**
 * Build a parameterized SQL value list for use with `IN (...)`.
 * Uses individual parameter bindings for safety.
 */
function sqlInList(values: string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * Resolve entity FK columns and backfill display names in a single function.
 *
 * For each field mapping:
 * 1. SET entityIdColumn = e.stable_id FROM entities WHERE the raw ID matches
 *    either e.stable_id or e.id (slug), skipping 'new:' prefixed values
 * 2. Backfill displayNameColumn from rawIdColumn when FK is still NULL and
 *    the raw ID looks like a human-readable name (not a machine ID)
 */
export async function resolveEntityFKs(
  tx: DbOrTx,
  options: ResolveEntityFKsOptions,
): Promise<ResolutionStats> {
  const { tableName, fields, scopeIds } = options;
  let totalResolved = 0;
  let totalBackfilled = 0;

  // Use sql.raw() for dynamic table/column identifiers.
  // These values come from our own code (not user input), so sql.raw() is safe.
  const tableIdent = sql.raw(tableName);

  const scopeClause =
    scopeIds && scopeIds.length > 0
      ? sql` AND t.id IN (${sqlInList(scopeIds)})`
      : sql``;

  for (const field of fields) {
    const rawCol = sql.raw(field.rawIdColumn);
    const entityCol = sql.raw(field.entityIdColumn);

    // Step 1: Resolve FK — match raw ID to entity stableId or slug
    const typeClause = field.entityTypeFilter
      ? sql` AND e.entity_type = ${field.entityTypeFilter}`
      : sql``;

    const resolveResult = await tx.execute(sql`
      UPDATE ${tableIdent} t
      SET ${entityCol} = e.stable_id
      FROM entities e
      WHERE (e.stable_id = t.${rawCol} OR e.id = t.${rawCol})
        ${typeClause}
        AND t.${entityCol} IS NULL
        AND t.${rawCol} NOT LIKE 'new:%'
        ${scopeClause}
    `);

    const resolvedCount =
      "rowCount" in resolveResult ? Number(resolveResult.rowCount) : 0;
    totalResolved += resolvedCount;

    // Step 2: Backfill display name when FK is still NULL
    // Only if a displayNameColumn is configured
    if (field.displayNameColumn) {
      const displayCol = sql.raw(field.displayNameColumn);

      const backfillResult = await tx.execute(sql`
        UPDATE ${tableIdent} t
        SET ${displayCol} = t.${rawCol}
        WHERE t.${entityCol} IS NULL
          AND t.${displayCol} IS NULL
          AND t.${rawCol} NOT LIKE 'sid_%'
          AND t.${rawCol} NOT LIKE 'new:%'
          ${scopeClause}
      `);

      const backfilledCount =
        "rowCount" in backfillResult ? Number(backfillResult.rowCount) : 0;
      totalBackfilled += backfilledCount;
    }
  }

  if (totalResolved > 0 || totalBackfilled > 0) {
    logger.info(
      { table: tableName, resolved: totalResolved, backfilled: totalBackfilled },
      "resolveEntityFKs completed",
    );
  }

  return { resolved: totalResolved, backfilled: totalBackfilled };
}
