/**
 * Shared factory for creating /delete-batch endpoints on tablebase routes.
 *
 * Every tablebase route with a /sync endpoint should also support deletion
 * for deduplication and cleanup. This factory eliminates the copy-paste that
 * caused 20+ routes to ship without delete endpoints.
 *
 * Usage in a route file:
 *
 *   import { deleteBatchHandler } from "../shared/delete-batch.js";
 *   import { myTable } from "../../schema.js";
 *
 *   const myApp = new Hono()
 *     .get("/stats", ...)
 *     .post("/sync", ...)
 *     .post("/delete-batch", deleteBatchHandler(myTable, "my_table"));
 */

import type { Context } from "hono";
import { z } from "zod";
import { inArray, and, eq } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { things } from "../../schema.js";
import { parseJsonBody, validationError, invalidJsonError } from "./utils.js";

/**
 * Create a standard /delete-batch handler for a tablebase route.
 *
 * @param table - The drizzle table object (must have an `id` column)
 * @param thingsSourceTable - The sourceTable value used in the things table
 *   for this entity type (e.g., "grants", "funding_rounds"). Pass null if
 *   this table doesn't sync to things.
 * @param options.maxBatchSize - Maximum IDs per request (default: 500)
 * @param options.label - Human-readable name for log messages (default: thingsSourceTable)
 * @param options.pkColumn - Primary key column to match against (default: table.id)
 */
export function deleteBatchHandler<T extends PgTable>(
  table: T,
  thingsSourceTable: string | null,
  options?: { maxBatchSize?: number; label?: string; pkColumn?: PgColumn; maxIdLength?: number }
) {
  const maxBatchSize = options?.maxBatchSize ?? 500;
  const label = options?.label ?? thingsSourceTable ?? "records";
  // Default to table.id; override with options.pkColumn for tables with non-standard PKs.
  // All standard tablebase tables have an `id` column; non-standard PKs must pass pkColumn.
  const pkColumn: PgColumn = options?.pkColumn ?? (table as any).id; // as-any-ok: PgTable generic doesn't expose column names; all 20+ callers have .id
  // Most IDs are varchar(10) but text-type PKs (resources, research areas, benchmarks)
  // can be longer slugs or composite keys. Default 200 accommodates all current formats.
  const maxIdLength = options?.maxIdLength ?? 200;

  const schema = z.object({
    ids: z.array(z.string().min(1).max(maxIdLength)).min(1).max(maxBatchSize),
  });

  return async (c: Context) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = schema.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { ids } = parsed.data;
    const db = getDrizzleDb();

    logger.info({ count: ids.length }, `Deleting ${label} batch`);

    await db.transaction(async (tx) => {
      // Delete from things table first (FK-safe)
      if (thingsSourceTable) {
        await tx
          .delete(things)
          .where(
            and(
              eq(things.sourceTable, thingsSourceTable),
              inArray(things.sourceId, ids)
            )
          );
      }

      // Delete the domain records
      await tx.delete(table).where(inArray(pkColumn, ids));
    });

    return c.json({ deleted: ids.length });
  };
}
