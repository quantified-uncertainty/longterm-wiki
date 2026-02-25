import { sql } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Batch-check that all IDs in `ids` exist in the given table/column.
 * Returns the subset of `ids` that do NOT exist (i.e. dangling references).
 *
 * Uses a single SELECT query to avoid N+1 lookups.
 */
export async function checkRefsExist(
  db: PostgresJsDatabase<any>,
  table: PgTable,
  column: PgColumn,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];

  const unique = [...new Set(ids)];

  // Build parameterized query: SELECT column FROM table WHERE column IN (...)
  const placeholders = unique.map((id) => sql`${id}`);
  const inList = sql.join(placeholders, sql`, `);

  const rows = await db.execute(
    sql`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${inList})`
  );

  const found = new Set(
    (rows as unknown as Array<{ id: string }>).map((r) => r.id)
  );
  return unique.filter((id) => !found.has(id));
}
