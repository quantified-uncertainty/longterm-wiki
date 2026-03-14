/**
 * Shared dual-write helper for upserting things from domain sync handlers.
 *
 * Domain routes call `upsertThingsInTx(tx, items)` inside their existing
 * transaction to keep the things table in sync without duplicating upsert logic.
 */

import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../schema.js";
import { things } from "../schema.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export interface ThingSyncInput {
  id: string;
  thingType: string;
  title: string;
  sourceTable: string;
  sourceId: string;
  parentThingId?: string | null;
  entityType?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  numericId?: string | null;
}

/**
 * Upsert things rows inside an existing transaction.
 * Uses ON CONFLICT (source_table, source_id) DO UPDATE to keep things in sync.
 * Skips parentThingId in the UPDATE set — it's backfilled by migration 0087
 * and rarely changes, keeping dual-write lean.
 */
export async function upsertThingsInTx(
  tx: DbOrTx,
  items: ThingSyncInput[]
): Promise<void> {
  if (items.length === 0) return;

  const allVals = items.map((item) => ({
    id: item.id,
    thingType: item.thingType,
    title: item.title,
    sourceTable: item.sourceTable,
    sourceId: item.sourceId,
    parentThingId: item.parentThingId ?? null,
    entityType: item.entityType ?? null,
    description: item.description ?? null,
    sourceUrl: item.sourceUrl ?? null,
    numericId: item.numericId ?? null,
  }));

  await tx
    .insert(things)
    .values(allVals)
    .onConflictDoUpdate({
      target: [things.sourceTable, things.sourceId],
      set: {
        title: sql`excluded.title`,
        thingType: sql`excluded.thing_type`,
        entityType: sql`excluded.entity_type`,
        description: sql`excluded.description`,
        sourceUrl: sql`excluded.source_url`,
        numericId: sql`excluded.numeric_id`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}
